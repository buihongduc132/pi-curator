/**
 * verification.test.ts — guard tests for the add-curator-signal verification +
 * cleanup cycle (tasks 4.3 / 7.1 / 7.2). These lock in invariants that the
 * signal layer must keep forever:
 *   - 4.3: the fallback findings file format is a STABLE CONTRACT consumed by
 *          `add-curator-lifecycle` `/curator status` (lifecycle task 9.2).
 *   - 7.1: NO email-bus dependency (REQ-SG-10).
 *   - 7.2: NO spawn/fork/janitor/persona-config/trim logic leaked (REQ-SG-12).
 *
 * They read the shipped source so a future regression breaks the build.
 */
// @ts-nocheck
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  resolveFindingsFilePath,
  formatFallbackLine,
  type FallbackFinding,
} from "./curator-receiver";

const EXT_DIR = __dirname;
const SHIPPED_TS_FILES = readdirSync(EXT_DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => join(EXT_DIR, f));
const SOURCE_BLOB = SHIPPED_TS_FILES.map((f) => readFileSync(f, "utf8")).join(
  "\n",
);

// ─── Task 4.3: fallback findings file = STABLE CONTRACT for lifecycle 9.2 ──

describe("task 4.3 — fallback findings file format contract (REQ-SG-07/08)", () => {
  it("locks the file path layout consumed by add-curator-lifecycle /curator status", () => {
    // CONTRACT: ~/.pi-curator/findings/<mainSessionId>/<curator>-<ts>.jsonl
    // lifecycle task 9.2 (`/curator status`) MUST parse this exact layout.
    const p = resolveFindingsFilePath("/home/u", "ses_main", "spec", 1782000000000);
    expect(p).toBe("/home/u/.pi-curator/findings/ses_main/spec-1782000000000.jsonl");
  });

  it("locks the JSONL record fields the consumer reads", () => {
    // CONTRACT fields: kind, message, mainSessionId, curatorAlias.
    const rec = JSON.parse(
      formatFallbackLine({
        kind: "steer",
        message: "x",
        mainSessionId: "m",
        curatorAlias: "c",
      } satisfies FallbackFinding),
    ) as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(
      ["curatorAlias", "kind", "mainSessionId", "message"],
    );
  });

  it("documents the stable-contract cross-ref to lifecycle `/curator status` (task 9.2)", () => {
    // The shipped source MUST explicitly record that this file format is a
    // STABLE CONTRACT consumed by add-curator-lifecycle's `/curator status`
    // (lifecycle task 9.2), so a future editor cannot silently break the
    // inter-change contract.
    expect(SOURCE_BLOB).toMatch(/STABLE CONTRACT/i);
    expect(SOURCE_BLOB).toMatch(/add-curator-lifecycle/);
    expect(SOURCE_BLOB).toMatch(/\/curator status/i);
  });
});

// ─── Task 7.1: no email-bus dependency (REQ-SG-10) ─────────────────────────

describe("task 7.1 — no email-bus dependency (REQ-SG-10)", () => {
  it("the signal layer never calls email_pub / email_sub / email-bus", () => {
    // Locked decision: WIP — the curator→main path depends only on
    // pi-intercom + the local fallback file.
    const forbidden = /email[_-]?(pub|sub)|email[_-]?bus/i;
    const hits = SHIPPED_TS_FILES
      .map((f) => ({ f, src: readFileSync(f, "utf8") }))
      .filter(({ src }) => forbidden.test(src));
    expect(hits).toEqual([]);
  });
});

// ─── Task 7.2: no lifecycle-owned logic leaked (REQ-SG-12) ─────────────────

describe("task 7.2 — no spawn/fork/janitor/persona-config/trim leaked (REQ-SG-12)", () => {
  it("the signal layer contains no spawn/fork/pm2/janitor/trim implementation", () => {
    // These are owned by add-curator-lifecycle. The only allowed mentions are
    // in prose comments describing the division of responsibility — never an
    // actual call. Assert no child_process spawn/fork imports or pm2 calls.
    const forbiddenImpl = /child_process|\bpm2\b|spawnSync|execSync|fork\(|spawn\(|janitor\b.*\b(sweep|gc|reap)\b|trimSession|trim-session/i;
    SHIPPED_TS_FILES.forEach((f) => {
      const src = readFileSync(f, "utf8");
      // Strip pure-prose comment lines so cross-ref prose (e.g. "spawned by
      // add-curator-lifecycle") is not a false positive.
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(code, `${f} leaked lifecycle-owned logic`).not.toMatch(forbiddenImpl);
    });
  });
});
