/**
 * finding.ts — cross-check mailbox entry types + pure helpers.
 *
 * Implements the on-disk finding/agreement entry contract from the
 * curator-crosscheck spec (REQ: "First-finding-wins dedup with
 * append-agreement" + "Append-only mailbox with atomic line writes").
 *
 * ## Mailbox entry shapes (LOCKED by spec)
 *
 * finding entry (one JSON line):
 *   {"type":"finding","topic":"<slug>","curator":"<alias>",
 *    "ts":"<iso>","severity":"<sev>","summary":"<text>"}
 *
 * agreement entry (one JSON line):
 *   {"type":"agreement","topic":"<slug>","curator":"<alias>",
 *    "ts":"<iso>","severity":"<sev>"}
 *
 * ## Dedup key (LOCKED by spec D3)
 *
 * Topic matching SHALL be exact, case-insensitive, after trimming surrounding
 * whitespace. NO fuzzy matching, NO embedding search, NO canonicalization.
 * Two curators that both emit `"failing-ci"` dedup; two that disagree on the
 * slug both signal (correctly preserving disagreement).
 *
 * ## Severity
 *
 * Mirrors `add-curator-signal`'s `signal_main` severity enum, confirmed in
 * design.md Decision Log (2026-06-23): `"info" | "warn" | "critical"`.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Severity enum shared with `signal_main` (add-curator-signal). */
export type Severity = "info" | "warn" | "critical";

/** Ordered severity for comparison only (NOT for weighted voting — spec forbids). */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  info: 0,
  warn: 1,
  critical: 2,
});

/** Entry type discriminator. */
export type EntryType = "finding" | "agreement";

/** A finding entry written by a curator that DID signal main. */
export interface Finding {
  type: "finding";
  /** LLM-extracted short slug identifying the issue (the dedup key, D3). */
  topic: string;
  /** Curator persona alias that produced this finding. */
  curator: string;
  /** ISO-8601 timestamp the finding was written. */
  ts: string;
  /** Severity carried through to `signal_main`. */
  severity: Severity;
  /** Short human-readable summary of the finding (NOT used for dedup). */
  summary: string;
}

/** An agreement entry written by a curator that SUPPRESSED its own signal. */
export interface Agreement {
  type: "agreement";
  topic: string;
  curator: string;
  ts: string;
  severity: Severity;
}

/** Union of all mailbox line types. */
export type MailboxEntry = Finding | Agreement;

/** A raw/parsed object of unknown shape (from JSON.parse). */
type RawEntry = Record<string, unknown>;

// ─── Severity helpers ───────────────────────────────────────────────────────

/**
 * Type guard + validator for the severity enum. Unknown strings → null.
 * Pure.
 */
export function isValidSeverity(v: unknown): v is Severity {
  return v === "info" || v === "warn" || v === "critical";
}

// ─── Topic / dedup key ──────────────────────────────────────────────────────

/**
 * Normalize a topic slug into its dedup key: lowercase + trimmed.
 *
 * Implements spec D3 EXACTLY: "case-insensitive, after trimming surrounding
 * whitespace. No fuzzy matching, embedding search, or canonicalization."
 *
 * Pure, total (never throws; non-string → "").
 */
export function topicKey(topic: unknown): string {
  if (typeof topic !== "string") return "";
  return topic.trim().toLowerCase();
}

/**
 * Stable dedup key for an entry: its normalized topic.
 *
 * Per spec, dedup is keyed by TOPIC ONLY (within a main session). Curator and
 * ts are deliberately excluded so a second curator hitting the same topic
 * collapses onto the first. mainSessionId is NOT part of the entry (it is
 * encoded in the mailbox PATH, design D6) so it is not part of this key.
 *
 * Pure.
 */
export function dedupKey(entry: Pick<MailboxEntry, "topic">): string {
  return topicKey(entry.topic);
}

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Normalize a raw parsed object into a typed `Finding`, or return null if it
 * is not a valid finding entry.
 *
 * Validation (per spec finding shape):
 *   type === "finding"; topic non-empty after trim; curator non-empty;
 *   severity ∈ enum; summary is a string (may be empty).
 * Pure, total (never throws).
 */
export function normalizeFinding(raw: RawEntry): Finding | null {
  if (raw.type !== "finding") return null;
  const topic = typeof raw.topic === "string" ? raw.topic.trim() : "";
  const curator = typeof raw.curator === "string" ? raw.curator.trim() : "";
  const ts = typeof raw.ts === "string" ? raw.ts : "";
  const summary = typeof raw.summary === "string" ? raw.summary : "";
  if (!topic || !curator) return null;
  if (!isValidSeverity(raw.severity)) return null;
  return {
    type: "finding",
    topic,
    curator,
    ts,
    severity: raw.severity,
    summary,
  };
}

/**
 * Normalize a raw parsed object into a typed `Agreement`, or null.
 * Pure, total.
 */
export function normalizeAgreement(raw: RawEntry): Agreement | null {
  if (raw.type !== "agreement") return null;
  const topic = typeof raw.topic === "string" ? raw.topic.trim() : "";
  const curator = typeof raw.curator === "string" ? raw.curator.trim() : "";
  const ts = typeof raw.ts === "string" ? raw.ts : "";
  if (!topic || !curator) return null;
  if (!isValidSeverity(raw.severity)) return null;
  return {
    type: "agreement",
    topic,
    curator,
    ts,
    severity: raw.severity,
  };
}

/**
 * Normalize a raw parsed object into any valid `MailboxEntry`, or null if it
 * matches neither shape. Pure, total (never throws).
 *
 * Used by the mailbox reader so a single malformed line is skipped without
 * aborting the whole read (REQ: "Cross-check failures MUST fail open").
 */
export function normalizeEntry(raw: unknown): MailboxEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawEntry;
  if (r.type === "finding") return normalizeFinding(r);
  if (r.type === "agreement") return normalizeAgreement(r);
  return null;
}

// ─── Serialization ──────────────────────────────────────────────────────────

/**
 * Serialize an entry to a single-line JSON string for the append-only mailbox.
 *
 * Fields are emitted in the spec-mandated order so output is deterministic and
 * grep-friendly. No trailing newline (the writer adds it). Pure.
 */
export function serializeEntry(entry: MailboxEntry): string {
  if (entry.type === "finding") {
    const f = entry as Finding;
    return JSON.stringify({
      type: "finding",
      topic: f.topic,
      curator: f.curator,
      ts: f.ts,
      severity: f.severity,
      summary: f.summary,
    });
  }
  const a = entry as Agreement;
  return JSON.stringify({
    type: "agreement",
    topic: a.topic,
    curator: a.curator,
    ts: a.ts,
    severity: a.severity,
  });
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse one mailbox line into a typed entry, or null if blank/malformed.
 *
 * Per spec "Mailbox parse failure falls back to independent signal": malformed
 * lines are skipped, NOT thrown. Pure, total (never throws).
 */
export function parseEntry(line: string): MailboxEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return normalizeEntry(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Parse an entire mailbox file's text into a list of valid entries.
 * Malformed/blank lines are silently skipped (REQ fail-open). Pure, total.
 */
export function parseMailboxText(text: string): MailboxEntry[] {
  const out: MailboxEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = parseEntry(line);
    if (entry) out.push(entry);
  }
  return out;
}
