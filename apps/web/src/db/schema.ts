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
