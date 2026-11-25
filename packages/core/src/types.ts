/** One minute of raw evidence from one device. `m` is unix time in whole minutes. */
export interface MinuteRecord {
  m: number;
  /** Key presses (count only, never which keys). */
  keys: number;
  /** Mouse clicks + scroll events. */
  clicks: number;
  /** Mouse move events. */
  moves: number;
  /** Front app name, e.g. "Code". */
  app?: string | null;
  /** Site domain when the front app is a browser, e.g. "claude.ai". */
  domain?: string | null;
  /** Prompts this person sent to Claude Code in this minute. */
  claudePrompts: number;
  /** Claude was working on one of their prompts during this minute. */
  claudeActive: boolean;
  /** Claude tokens (in + out) used in this minute. */
  tokens: number;
  /** Commits made in this minute. */
  commits: number;
  /** The employee had tracking paused (private time). */
  paused: boolean;
  /** Title of the front window, e.g. "#general - Acme - Slack". */
  title?: string | null;
  /** Page path when the front app is a browser, e.g. "/acme/api/pulls". No query string. */
  path?: string | null;
  /** Repository or folder the front terminal or editor is working in. */
  repo?: string | null;
  /** A call was in progress (microphone in use). */
  call?: boolean;
  /** Projects (repo names) Claude Code was working in during this minute. */
  claudeProjects?: string[];
  /** Repos committed to in this minute. */
  commitRepos?: string[];
}

export type MinuteStatus =
  /** Human input in this minute. */
  | "active"
  /** No input, but shortly after input (reading, thinking). */
  | "grace"
  /** No input, but Claude is working on their prompt and they were recently here. */
  | "claude"
  /** No input, but on a call. */
  | "meeting"
  /** Time on the person's own private project: not the company's to count. Set by the server. */
  | "personal"
  | "idle"
  | "paused";

export interface VerifiedMinute extends MinuteRecord {
  status: MinuteStatus;
  /** Counts toward paid time. */
  verified: boolean;
  /** Part of a call that has gone on for a long time with no input at all. */
  longCall?: boolean;
}

export type Evidence = "strong" | "normal" | "weak";

export interface HourSummary {
  /** Unix hour (minutes / 60, floored). */
  h: number;
  verifiedMinutes: number;
  evidence: Evidence;
}

export interface VerifyOptions {
  /** Minutes after last input that still count (reading, thinking). */
  graceMinutes: number;
  /** Minutes after last input that count while Claude is working for them. */
  claudeGraceMinutes: number;
  /** A call with no input at all is flagged as thin evidence after this many minutes. */
  silentCallMinutes: number;
}

export const DEFAULT_VERIFY: VerifyOptions = {
  graceMinutes: 5,
  claudeGraceMinutes: 15,
  silentCallMinutes: 120,
};
