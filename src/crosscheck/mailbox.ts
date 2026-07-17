/**
 * mailbox.ts — per-main-session shared findings JSONL mailbox.
 *
 * Implements the curator-crosscheck file mailbox contract (design D1, D6):
 *   path: ~/.pi-curator/findings/<mainSessionId>/shared.jsonl
 *   append-only, one JSON object per line, POSIX O_APPEND semantics for
 *   atomic line writes under 4 KiB (spec requires no locking for v1).
 *
 * All failures are FAIL-OPEN: read/parse errors return an empty list so the
 * caller falls back to independent signaling (REQ: "Cross-check failures MUST
 * fail open and never block").
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseEntry, serializeEntry, type MailboxEntry } from "./finding.js";

// ─── Path convention ────────────────────────────────────────────────────────

/**
 * Resolve the shared mailbox path for a given main session.
 *
 * Default root is `~/.pi-curator`. If a custom root is provided and is not
 * absolute, it is resolved relative to the current working directory.
 *
 * Pure (no filesystem access).
 */
export function mailboxPath(
  mainSessionId: string,
  opts?: { root?: string },
): string {
  const root = opts?.root ?? join(homedir(), ".pi-curator");
  const base = isAbsolute(root) ? root : join(process.cwd(), root);
  return join(base, "findings", mainSessionId, "shared.jsonl");
}

// ─── IO abstraction (injected for testability) ─────────────────────────────

/** A minimal filesystem slice used by the mailbox implementation. */
export interface MailboxFs {
  /** Read the whole file. Returns raw text or null on error/missing. */
  readFile: (path: string) => Promise<string | null>;
  /** Append a single line to the file, creating it if necessary. */
  appendLine: (path: string, line: string) => Promise<void>;
  /** Ensure the parent directory exists. */
  mkdirp: (dir: string) => Promise<void>;
}

/** Default production fs using Node built-ins. */
export function makeRealFs(): MailboxFs {
  return {
    async readFile(path: string): Promise<string | null> {
      const { readFile } = await import("node:fs/promises");
      try {
        return await readFile(path, "utf-8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        throw err; // rethrow to be caught by fail-open wrapper in readMailbox
      }
    },
    async appendLine(path: string, line: string): Promise<void> {
      const { open } = await import("node:fs/promises");
      const handle = await open(path, "a"); // 'a' = O_APPEND + create-if-missing
      try {
        await handle.write(`${line}\n`);
      } finally {
        await handle.close();
      }
    },
    async mkdirp(dir: string): Promise<void> {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
    },
  };
}

// ─── Read / append ──────────────────────────────────────────────────────────

/**
 * Read the shared mailbox, skipping blank/malformed lines.
 *
 * FAIL-OPEN: any error (missing file, permission denied, parse error) returns
 * an empty list. The caller MUST then proceed as if cross-check is disabled.
 *
 * @param fs optional injected fs for testing. Defaults to real Node fs.
 */
export async function readMailbox(
  path: string,
  fs: MailboxFs = makeRealFs(),
): Promise<MailboxEntry[]> {
  try {
    const text = await fs.readFile(path);
    if (text === null) return [];
    const out: MailboxEntry[] = [];
    for (const line of text.split("\n")) {
      const entry = parseEntry(line);
      if (entry) out.push(entry);
    }
    return out;
  } catch (err) {
    // Debug-only log if a logger is provided; otherwise swallow silently.
    if (typeof process !== "undefined" && process.env?.DEBUG?.includes("curator")) {
      // eslint-disable-next-line no-console
      console.debug("[crosscheck] readMailbox fail-open:", err);
    }
    return [];
  }
}

/**
 * Append one entry to the mailbox as a single atomic line.
 *
 * FAIL-OPEN: the caller SHOULD have already called `signal_main` (or is about
 * to) per the spec: "curator SHALL have already called (or shall still call)
 * signal_main for the finding". Any append error here is silently ignored.
 *
 * @param fs optional injected fs for testing. Defaults to real Node fs.
 */
export async function appendEntry(
  path: string,
  entry: MailboxEntry,
  fs: MailboxFs = makeRealFs(),
): Promise<void> {
  try {
    await fs.mkdirp(dirname(path));
    await fs.appendLine(path, serializeEntry(entry));
  } catch (err) {
    if (typeof process !== "undefined" && process.env?.DEBUG?.includes("curator")) {
      // eslint-disable-next-line no-console
      console.debug("[crosscheck] appendEntry fail-open:", err);
    }
  }
}
