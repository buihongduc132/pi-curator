/**
 * filter-session.ts — non-bias context filter (REQ-LC-02, foundation T2).
 *
 * Reads a pi main-session JSONL and emits a filtered fork-input JSONL that a
 * curator side-car (`pi --fork`) consumes. The filter implements the
 * "non-bias" contract from the curator-lifecycle spec:
 *
 *   (a) operate on the ACTIVE BRANCH only (ignore off-branch entries from
 *       abandoned conversation branches);
 *   (b) drop `thinking` blocks from assistant messages (the most biased
 *       signal — main's self-justifying reasoning); opt-in via
 *       `includeThinking: true` (default false, design D4);
 *   (c) PRESERVE `compaction` entries intact — they carry pre-compaction
 *       requirements and MUST NOT be dropped (verifier C5);
 *   (d) preserve `message`, `custom_message`, and `branch_summary` entries;
 *   (e) discard non-context entry types: `session_info`, `model_change`,
 *       `thinking_level_change`, `label` (and `custom` extension-state
 *       entries which never participate in LLM context).
 *
 * Malformed JSONL lines are SKIPPED (never throw) per REQ-LC-10 exception
 * safety — a single bad line does not abort the filter.
 *
 * ## Design: pure functions
 *
 * Every function here is pure over its arguments so it is fully unit-testable
 * with no filesystem. The main entry {@link filterSession} takes the raw JSONL
 * text and returns filtered JSONL text; {@link filterSessionFile} is a thin
 * I/O wrapper.
 *
 * ## JSONL format reference
 *
 * See pi's `docs/session-format.md`. Entries form a tree via `id`/`parentId`;
 * the active branch is the path from the current leaf back to the root.
 * Content blocks on assistant messages include `{type:"thinking",...}` which
 * this filter strips by default.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** A parsed JSONL entry (loosely-typed: real entries vary by `type`). */
export interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: unknown;
  [key: string]: unknown;
}

/** The session header (first line, has no id/parentId). */
export interface SessionHeader {
  type: "session";
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
  [key: string]: unknown;
}

/** Options for {@link filterSession}. */
export interface FilterOptions {
  /**
   * Include assistant `thinking` content blocks (default `false` — non-bias,
   * REQ-LC-02 / design D4). When `false`, thinking blocks are stripped from
   * every assistant message; all other content is preserved verbatim.
   */
  includeThinking?: boolean;
  /**
   * Explicit leaf entry id. When omitted, the leaf defaults to the LAST entry
   * in the file (entries are append-only, so the last line is the current
   * tip). Callers that hold a live SessionManager may pass its `getLeafId()`.
   */
  leafId?: string;
}

/** Result of parsing a JSONL document into header + entries. */
export interface ParsedSession {
  header: SessionHeader | null;
  entries: SessionEntry[];
  /** Count of lines that failed to parse as JSON (REQ-LC-10 — skipped). */
  malformedLines: number;
  /** Count of blank lines encountered (ignored). */
  blankLines: number;
}

// ─── Entry-type classification (REQ-LC-02) ─────────────────────────────────

/**
 * Entry types that survive filtering and participate in LLM context. Per
 * REQ-LC-02: `message`, `custom_message`, `branch_summary`, and `compaction`.
 * Everything else (custom/label/model_change/thinking_level_change/
 * session_info) is a non-context entry type and is discarded.
 */
const CONTEXT_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "message",
  "custom_message",
  "branch_summary",
  "compaction",
]);

/** True if the entry type participates in LLM context (kept by the filter). */
export function isContextEntryType(type: string): boolean {
  return CONTEXT_ENTRY_TYPES.has(type);
}

// ─── Active-branch computation ──────────────────────────────────────────────

/**
 * Compute the set of entry ids on the active branch — the path from `leafId`
 * back to the root via `parentId`. Entries whose id is NOT in this set are
 * off-branch (from abandoned conversation branches) and must be excluded
 * (REQ-LC-02 "Only active branch is included").
 *
 * The walk is tolerant: a missing or dangling `parentId` simply terminates
 * the chain (so a malformed/skipped parent does not abort filtering). Pure.
 *
 * @param entries parsed session entries (any order; typically chronological)
 * @param leafId  id of the leaf entry (current tip of the tree)
 * @returns set of ids on the leaf→root path, INCLUDING the leaf
 */
export function computeActiveBranchIds(
  entries: ReadonlyArray<SessionEntry>,
  leafId: string,
): Set<string> {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) {
    if (typeof e.id === "string") byId.set(e.id, e);
  }
  const active = new Set<string>();
  let cursor: string | undefined = leafId;
  // Guard against a malformed cycle with a visit cap (entries are finite).
  const max = entries.length + 1;
  while (cursor && active.size < max) {
    if (active.has(cursor)) break; // cycle guard
    const node = byId.get(cursor);
    if (!node) break; // dangling parent — stop without adding the missing id
    active.add(cursor);
    const parent = node.parentId;
    cursor = typeof parent === "string" && parent.length > 0 ? parent : undefined;
  }
  return active;
}

/**
 * Resolve the active-branch leaf id. Defaults to the LAST entry in file order
 * (entries are append-only, so the last written entry is the current tip).
 * Pure.
 */
export function resolveLeafId(entries: ReadonlyArray<SessionEntry>): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const id = entries[i].id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

// ─── Thinking-block stripping (REQ-LC-02) ───────────────────────────────────

/** A content block on a message (loosely typed — real blocks carry payloads). */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

/** A message (the `message` field of a `type:"message"` entry). */
export interface MessageLike {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

/**
 * Strip `thinking` content blocks from a message's content array, returning a
 * NEW message object (never mutates the input). Only assistant-role messages
 * carry thinking blocks; for other roles the message is returned unchanged.
 *
 * - String content is returned as-is (no blocks to strip).
 * - Non-array content is returned as-is.
 * - An assistant message whose content becomes empty after stripping keeps an
 *   empty array (the message survives; downstream trim handles empties).
 *
 * Pure. (REQ-LC-02 "Thinking blocks are stripped".)
 */
export function stripThinkingBlocks(message: MessageLike): MessageLike {
  if (message.role !== "assistant") return message;
  const content = message.content;
  if (!Array.isArray(content)) return message;
  const filtered = content.filter(
    (block: unknown) => !(typeof block === "object" && block !== null && (block as ContentBlock).type === "thinking"),
  );
  // No thinking blocks present → return original (avoid needless copies).
  if (filtered.length === content.length) return message;
  return { ...message, content: filtered };
}

// ─── Entry transformation ───────────────────────────────────────────────────

/**
 * Transform a single kept entry: for assistant messages, strip thinking blocks
 * unless `includeThinking` is set. Returns a NEW entry (never mutates input).
 * Non-message entries pass through unchanged. Pure.
 */
export function transformEntry(
  entry: SessionEntry,
  opts: { includeThinking?: boolean } = {},
): SessionEntry {
  if (entry.type !== "message") return entry;
  const message = entry.message;
  if (!message || typeof message !== "object") return entry;
  if (opts.includeThinking) return entry;
  const cleaned = stripThinkingBlocks(message as MessageLike);
  if (cleaned === message) return entry;
  return { ...entry, message: cleaned };
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse a JSONL document into header + entries. Malformed lines are SKIPPED
 * (counted in `malformedLines`) per REQ-LC-10 — a single bad line never aborts
 * the filter. Blank lines are ignored. The first valid JSON line is treated
 * as the session header when its `type === "session"`. Pure.
 */
export function parseSession(input: string): ParsedSession {
  const lines = input.split("\n");
  let header: SessionHeader | null = null;
  const entries: SessionEntry[] = [];
  let malformedLines = 0;
  let blankLines = 0;
  let headerSeen = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      blankLines += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // REQ-LC-10: skip malformed line, continue.
      malformedLines += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      malformedLines += 1;
      continue;
    }
    const entry = parsed as SessionEntry;
    if (!headerSeen && entry.type === "session") {
      header = entry as SessionHeader;
      headerSeen = true;
      continue;
    }
    headerSeen = true;
    entries.push(entry);
  }
  return { header, entries, malformedLines, blankLines };
}

// ─── Core filter ────────────────────────────────────────────────────────────

/**
 * Filter the parsed session entries to the active-branch context entries,
 * stripping thinking blocks unless `includeThinking` is set. Pure.
 *
 * Pipeline: active-branch selection → context-type filter → thinking strip.
 * Returns the kept entries in their original (chronological) order.
 */
export function filterEntries(
  entries: ReadonlyArray<SessionEntry>,
  opts: FilterOptions = {},
): SessionEntry[] {
  const leafId = opts.leafId ?? resolveLeafId(entries);
  if (!leafId) return [];
  const active = computeActiveBranchIds(entries, leafId);

  const kept: SessionEntry[] = [];
  for (const entry of entries) {
    // Active-branch only (REQ-LC-02): drop off-branch entries.
    const id = entry.id;
    if (typeof id === "string" && !active.has(id)) continue;
    // Context-entry-type filter (REQ-LC-02): drop non-context types.
    if (!isContextEntryType(entry.type)) continue;
    kept.push(transformEntry(entry, { includeThinking: opts.includeThinking }));
  }
  return kept;
}

/**
 * Render entries (and an optional header) back to JSONL text, one JSON object
 * per line with a trailing newline. Pure.
 */
export function renderSession(
  header: SessionHeader | null,
  entries: ReadonlyArray<SessionEntry>,
): string {
  const lines: string[] = [];
  if (header) lines.push(JSON.stringify(header));
  for (const e of entries) lines.push(JSON.stringify(e));
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

/**
 * Filter a raw JSONL document into a filtered fork-input JSONL document.
 *
 * Implements the full non-bias contract (REQ-LC-02): active-branch only,
 * thinking stripped (unless `includeThinking`), compaction preserved,
 * message/custom_message/branch_summary preserved, non-context types dropped,
 * malformed lines skipped. The session header is preserved (needed for
 * `pi --fork` to recognize the file). Pure.
 */
export function filterSession(input: string, opts: FilterOptions = {}): string {
  const { header, entries } = parseSession(input);
  const kept = filterEntries(entries, opts);
  return renderSession(header, kept);
}

/**
 * Count how many entries were dropped by each rule, for diagnostics. Returns
 * tallies of off-branch, non-context-type, and thinking-block removals. Pure.
 *
 * Useful for the spawn hook's UI status ("curator: fork filtered N entries,
 * dropped M off-branch, K non-context") without re-running the filter.
 */
export interface FilterStats {
  total: number;
  kept: number;
  offBranch: number;
  nonContext: number;
  thinkingStripped: number;
}

export function analyzeFilter(
  entries: ReadonlyArray<SessionEntry>,
  opts: FilterOptions = {},
): FilterStats {
  const leafId = opts.leafId ?? resolveLeafId(entries);
  const active = leafId ? computeActiveBranchIds(entries, leafId) : new Set<string>();
  let offBranch = 0;
  let nonContext = 0;
  let thinkingStripped = 0;
  let kept = 0;
  for (const entry of entries) {
    const id = entry.id;
    if (typeof id === "string" && !active.has(id)) {
      offBranch += 1;
      continue;
    }
    if (!isContextEntryType(entry.type)) {
      nonContext += 1;
      continue;
    }
    if (entry.type === "message" && !opts.includeThinking) {
      const msg = entry.message;
      if (msg && typeof msg === "object" && (msg as MessageLike).role === "assistant") {
        const content = (msg as MessageLike).content;
        if (Array.isArray(content)) {
          const before = content.length;
          const after = content.filter(
            (b: unknown) =>
              !(typeof b === "object" && b !== null && (b as ContentBlock).type === "thinking"),
          ).length;
          if (after < before) thinkingStripped += 1;
        }
      }
    }
    kept += 1;
  }
  return { total: entries.length, kept, offBranch, nonContext, thinkingStripped };
}

export {};
