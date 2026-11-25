import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),
  /** First day of a pay period (YYYY-MM-DD). Periods repeat every `periodDays` from here. */
  periodAnchor: text("period_anchor").notNull(),
  periodDays: integer("period_days").notNull().default(14),
  createdAt: createdAt(),
});

/** People who sign in to the dashboard (owners). */
export const users = pgTable("users", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

/** People whose work is tracked. */
export const members = pgTable(
  "members",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    hourlyRateCents: integer("hourly_rate_cents").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("members_org_idx").on(t.orgId)],
);

/** Browser sessions. Owner sessions have userId; employee self-view sessions have memberId. */
export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").references(() => members.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const invites = pgTable("invites", {
  code: text("code").primaryKey(),
  memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const devices = pgTable(
  "devices",
  {
    id: id(),
    memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    platform: text("platform"),
    hostname: text("hostname"),
    appVersion: text("app_version"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("devices_member_idx").on(t.memberId)],
);

/** One-time codes that let the desktop app open the employee's own page in a browser. */
export const viewCodes = pgTable("view_codes", {
  codeHash: text("code_hash").primaryKey(),
  memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** Raw per-minute input evidence from the tracker. `m` is unix time in whole minutes. */
export const minutes = pgTable(
  "minutes",
  {
    deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
    m: integer("m").notNull(),
    keys: integer("keys").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    moves: integer("moves").notNull().default(0),
    app: text("app"),
    domain: text("domain"),
    paused: boolean("paused").notNull().default(false),
    /** Title of the front window. */
    title: text("title"),
    /** Page path in a browser, without the query string. */
    path: text("path"),
    /** Repository or folder the front terminal or editor was in. */
    repo: text("repo"),
    /** A call was in progress (microphone in use). */
    call: boolean("call").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.m] }), index("minutes_member_m_idx").on(t.memberId, t.m)],
);

/**
 * Claude Code usage per minute, session and project (metadata only, never message text).
 * A row means Claude was doing something for this person in that minute.
 */
export const claudeUsage = pgTable(
  "claude_usage",
  {
    deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
    m: integer("m").notNull(),
    sessionId: text("session_id").notNull(),
    project: text("project").notNull(),
    model: text("model"),
    prompts: integer("prompts").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.m, t.sessionId] }),
    index("claude_member_m_idx").on(t.memberId, t.m),
  ],
);

export const commits = pgTable(
  "commits",
  {
    memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    repo: text("repo").notNull(),
    m: integer("m").notNull(),
    added: integer("added").notNull().default(0),
    removed: integer("removed").notNull().default(0),
    subject: text("subject").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.sha] }), index("commits_member_m_idx").on(t.memberId, t.m)],
);

/** Time the owner adds or removes by hand (meetings, calls, corrections). */
export const adjustments = pgTable(
  "adjustments",
  {
    id: id(),
    memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    minutes: integer("minutes").notNull(),
    note: text("note").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("adjustments_member_day_idx").on(t.memberId, t.day)],
);

/** A locked pay period keeps the numbers that were approved, whatever arrives later. */
export const periodLocks = pgTable(
  "period_locks",
  {
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    periodIndex: integer("period_index").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.periodIndex] })],
);

/**
 * Who a project, client or invoice belongs to: the company when `ownerMemberId` is null,
 * otherwise one person privately. Private ones are never shown to the company.
 */
const owner = () => uuid("owner_member_id").references(() => members.id, { onDelete: "cascade" });

export const clients = pgTable(
  "clients",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    ownerMemberId: owner(),
    name: text("name").notNull(),
    /** Free text printed on invoices under the name: address, contact, tax number. */
    details: text("details").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("clients_org_idx").on(t.orgId)],
);

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    ownerMemberId: owner(),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#3b82f6"),
    /** What the client is billed per hour. */
    rateCents: integer("rate_cents").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("projects_org_idx").on(t.orgId)],
);

/** "Time that looks like this belongs to that project." See packages/core/src/attribute.ts. */
export const rules = pgTable(
  "rules",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    match: text("match").notNull(),
    app: text("app"),
    createdAt: createdAt(),
  },
  (t) => [index("rules_project_idx").on(t.projectId)],
);

/** A stretch of one person's time moved to a project by hand. `toM` is exclusive. */
export const assignments = pgTable(
  "assignments",
  {
    id: id(),
    memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
    fromM: integer("from_m").notNull(),
    toM: integer("to_m").notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("assignments_member_idx").on(t.memberId, t.fromM)],
);

export interface InvoiceLine {
  projectId: string | null;
  description: string;
  minutes: number;
  rateCents: number;
  amountCents: number;
}

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    ownerMemberId: owner(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    fromDay: text("from_day").notNull(),
    toDay: text("to_day").notNull(),
    issuedOn: text("issued_on").notNull(),
    /** draft, sent or paid */
    status: text("status").notNull().default("draft"),
    lines: jsonb("lines").$type<InvoiceLine[]>().notNull(),
    totalCents: integer("total_cents").notNull().default(0),
    notes: text("notes").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("invoices_org_idx").on(t.orgId)],
);

/** Project suggestions for unsorted time, made by Claude on the person's own computer. */
export const suggestions = pgTable(
  "suggestions",
  {
    memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    match: text("match").notNull(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.field, t.match] })],
);

/** A short summary of one person's day, written by Claude on their own computer. */
export const daySummaries = pgTable(
  "day_summaries",
  {
    memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.day] })],
);
