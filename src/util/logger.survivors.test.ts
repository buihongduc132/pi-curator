/**
 * logger.survivors.test.ts — targeted kills for stryker survivors in logger.ts.
 *
 * Each describe block documents the exact mutant(s) it kills and why the
 * assertion distinguishes the mutant from the original. Genuine equivalent
 * mutants (already-analyzed) are NOT targeted here; see the remediation notes
 * at the bottom of this file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createCuratorLogger, type LogRecord } from "./logger.js";

function readRecords(file: string): LogRecord[] {
  const raw = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  return raw.map((l) => JSON.parse(l) as LogRecord);
}

// ─── L69 envFlag: empty-string env value must collapse to undefined ──────────
//
// envFlag returns undefined when the env var is "" (empty). Mutants that drop
// the `v.length > 0` / `> 0` guard, or replace the whole ternary with `true`,
// make it return "" (or the raw value). resolveLogsDir then uses "" as the
// logsDir → the file lands at a CWD-relative path instead of the homedir
// default.
describe("logger — L69 envFlag empty-string collapse (resolveLogsDir default)", () => {
  // NOTE: we deliberately do NOT depend on process.env.HOME here. Stryker's
  // vitest runner can batch test files in one process where another file's
  // `process.env = { ...REAL_ENV }` afterEach would clobber a HOME override.
  // Instead we assert the NEGATIVE: under the mutants envFlag("") returns "",
  // logsDir becomes "", and path.join("", sessionId, ...) yields a CWD-relative
  // path → a "ses-empty/" dir appears in CWD. Under the original, envFlag
  // returns undefined and the file lands under the homedir default — never
  // CWD-relative.
  const cwdRelative = path.join(process.cwd(), "ses-empty");

  beforeEach(() => {
    process.env.PI_CURATOR_LOG_DIR = "";
  });

  afterEach(() => {
    delete process.env.PI_CURATOR_LOG_DIR;
    // Best-effort cleanup of any stray CWD-relative artifact (mutant path).
    try { fs.rmSync(cwdRelative, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("does NOT create a CWD-relative log path when PI_CURATOR_LOG_DIR is empty", () => {
    const log = createCuratorLogger({ sessionId: "ses-empty", scope: "x" });
    log.info("hi");
    // Original: envFlag("")===undefined → resolveLogsDir falls through to the
    // homedir default → no CWD-relative "ses-empty" dir.
    // Mutants: envFlag returns "" → logsDir="" → file at CWD-relative
    // "ses-empty/curator.jsonl" → the dir exists.
    expect(fs.existsSync(cwdRelative)).toBe(false);
  });
});

// ─── L78 nowUnixNano: ms→ns multiplication must not become division ──────────
//
// `String(BigInt(Date.now()) * 1_000_000n)` yields a ~19-digit nanosecond
// string. The ArithmeticOperator mutant (`*`→`/`) yields a ~7-digit string.
describe("logger — L78 nowUnixNano magnitude (ms*1e6, not ms/1e6)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-nano-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("observedTimeUnixNano is a high-magnitude nanosecond value (>1e15)", () => {
    const log = createCuratorLogger({ logsDir: dir, sessionId: "ses-nano", scope: "x" });
    log.info("hi");
    const rec = readRecords(path.join(dir, "ses-nano", "curator.jsonl"))[0];
    // Original: Date.now() (~1.78e12) * 1e6 ≈ 1.78e18 → 19 digits.
    // Mutant (/): ~1.78e12 / 1e6 ≈ 1.78e6 → 7 digits.
    const nano = BigInt(rec.observedTimeUnixNano);
    expect(nano > 1_000_000_000_000_000n).toBe(true); // > 1e15
    // Sanity: the digit count must be large (mutant produces ≤8 digits).
    expect(rec.observedTimeUnixNano.length).toBeGreaterThanOrEqual(16);
  });
});

// ─── L91/L93 resolveMaxBytes: env="0" must fall through to explicit ──────────
//
// PI_CURATOR_LOG_MAX_BYTES="0" is invalid (n>0 fails) → resolveMaxBytes must
// return the explicit value. Four L93 mutants make it return Math.floor(0)=0
// instead, which causes rotation on every write after the first.
describe("logger — L93 resolveMaxBytes env=\"0\" falls through to explicit", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-max0-"));
    process.env.PI_CURATOR_LOG_MAX_BYTES = "0";
  });
  afterEach(() => {
    delete process.env.PI_CURATOR_LOG_MAX_BYTES;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT rotate after two short writes when explicit maxBytes is large", () => {
    const log = createCuratorLogger({
      logsDir: dir,
      sessionId: "ses-max0",
      scope: "x",
      maxBytes: 4096, // explicit — must win over the invalid env="0"
    });
    log.info("short-a");
    log.info("short-b");
    const rolled = path.join(dir, "ses-max0", "curator.jsonl.1");
    // Original (explicit 4096): two short records << 4096 → no rotation.
    // Mutants (maxBytes=0): second write rotates → rolled exists.
    expect(fs.existsSync(rolled)).toBe(false);
    const recs = readRecords(path.join(dir, "ses-max0", "curator.jsonl"));
    expect(recs).toHaveLength(2);
  });
});

// ─── L93 resolveMaxBytes: env="Infinity" must fall through to explicit ───────
//
// PI_CURATOR_LOG_MAX_BYTES="Infinity": Number.isFinite(Infinity) is false →
// fall through. The LogicalOperator (`||`) mutant returns Infinity, the
// CondExpr-true mutant also returns Infinity → no rotation ever.
describe("logger — L93 resolveMaxBytes env=\"Infinity\" falls through to explicit", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-maxinf-"));
    process.env.PI_CURATOR_LOG_MAX_BYTES = "Infinity";
  });
  afterEach(() => {
    delete process.env.PI_CURATOR_LOG_MAX_BYTES;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rotates under the small explicit cap even when env=Infinity (invalid)", () => {
    const log = createCuratorLogger({
      logsDir: dir,
      sessionId: "ses-maxinf",
      scope: "x",
      maxBytes: 200,
    });
    for (let i = 0; i < 20; i++) log.info("payload " + "z".repeat(40));
    const rolled = path.join(dir, "ses-maxinf", "curator.jsonl.1");
    // Original (explicit 200): rotates → rolled exists.
    // Mutants (Infinity): never rotate → rolled absent.
    expect(fs.existsSync(rolled)).toBe(true);
  });
});

// ─── L100 resolveLevel: invalid env level must fall through to explicit ──────
//
// PI_CURATOR_LOG_LEVEL="xyz" is not a real level → resolveLevel must use the
// explicit level. The LogicalOperator (`||`) mutant returns "xyz" as a Level,
// which makes LEVEL_RANK["xyz"]=undefined → level-gate comparisons are always
// false → every record is emitted (the gate never triggers).
describe("logger — L100 resolveLevel invalid env falls through to explicit", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-lvlxyz-"));
    process.env.PI_CURATOR_LOG_LEVEL = "xyz";
  });
  afterEach(() => {
    delete process.env.PI_CURATOR_LOG_LEVEL;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("drops info records when explicit level=warn and env level is invalid", () => {
    const log = createCuratorLogger({
      logsDir: dir,
      sessionId: "ses-lvlxyz",
      scope: "x",
      level: "warn",
    });
    log.info("dropped");
    log.warn("kept");
    const recs = readRecords(path.join(dir, "ses-lvlxyz", "curator.jsonl"));
    const sevs = recs.map((r) => r.severity);
    // Original (level=warn): INFO dropped, WARN kept.
    // Mutant (level="xyz"): INFO emitted too (undefined rank disables gate).
    expect(sevs).not.toContain("INFO");
    expect(sevs).toContain("WARN");
  });
});

// ─── L130 rotation gate: size>0 strict guard + strict `>` comparison ─────────
//
// Two survivor clusters on the rotation condition:
//   (a) `size > 0` → mutants `true` / `size >= 0`: rotation must NOT fire when
//       the current file exists but is empty (size=0).
//   (b) `size + bytes > maxBytes` → mutant `>=`: rotation must NOT fire when
//       size+bytes EXACTLY equals maxBytes (boundary).
describe("logger — L130 rotation: empty current file must not rotate (size>0)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-rot-empty-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("does not rotate when an empty current file exists and the line exceeds maxBytes", () => {
    const sessionDir = path.join(dir, "ses-rot-empty");
    fs.mkdirSync(sessionDir, { recursive: true });
    const current = path.join(sessionDir, "curator.jsonl");
    const rolled = path.join(sessionDir, "curator.jsonl.1");
    // Pre-create an EMPTY current file (size=0).
    fs.writeFileSync(current, "");

    const log = createCuratorLogger({
      logsDir: dir,
      sessionId: "ses-rot-empty",
      scope: "x",
      maxBytes: 10, // line (>>10 bytes) exceeds cap, but size=0 → no rotation
    });
    log.info("this line is much longer than ten bytes payload padding");
    // Original (size>0 false): no rotation → rolled absent, content in current.
    // Mutants (size>=0 / true): rotation fires → renameSync(current→rolled)
    //   moves the empty file to rolled → rolled EXISTS.
    expect(fs.existsSync(rolled)).toBe(false);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.statSync(current).size).toBeGreaterThan(0);
  });
});

describe("logger — L130 rotation: strict `>` boundary (size+bytes == maxBytes)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-rot-bound-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("does not rotate when size+bytes exactly equals maxBytes", () => {
    // Step 1: write one record with a huge cap to learn the exact line length.
    const probeDir = path.join(dir, "probe");
    const probe = createCuratorLogger({
      logsDir: probeDir,
      sessionId: "ses",
      scope: "x",
      maxBytes: 1_000_000,
    });
    probe.info("payload");
    const probeFile = path.join(probeDir, "ses", "curator.jsonl");
    const lineLen = fs.statSync(probeFile).size - 1; // exclude trailing \n

    // Step 2: fresh logger where 2nd write hits the boundary exactly.
    // After write 1: size = lineLen + 1 (the \n).
    // Write 2: size + lineLen = (lineLen+1) + lineLen = 2*lineLen + 1.
    // Set maxBytes = 2*lineLen + 1 → strict `>` is false (no rotation),
    // but the `>=` mutant IS true (rotation).
    const bound = 2 * lineLen + 1;
    const log = createCuratorLogger({
      logsDir: dir,
      sessionId: "ses",
      scope: "x",
      maxBytes: bound,
    });
    log.info("payload");
    log.info("payload");
    const current = path.join(dir, "ses", "curator.jsonl");
    const rolled = path.join(dir, "ses", "curator.jsonl.1");
    // Original (strict >): no rotation on the boundary → 2 records, no roll.
    // Mutant (>=): rotates on 2nd write → rolled exists, current has 1 record.
    expect(fs.existsSync(rolled)).toBe(false);
    expect(readRecords(current)).toHaveLength(2);
  });
});

// ─── L198/L199 trace/debug methods must actually emit (not be no-ops) ────────
//
// `trace: (m,a)=>emit("trace",m,a)` and `debug: ...` ArrowFunction mutants
// replace the body with `() => undefined`. At level=trace both must write.
describe("logger — L198/L199 trace+debug methods emit at level=trace", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-log-trace-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("trace() and debug() write TRACE and DEBUG records when level=trace", () => {
    const log = createCuratorLogger({
      logsDir: dir,
      sessionId: "ses-trace",
      scope: "x",
      level: "trace",
    });
    log.trace("t-msg");
    log.debug("d-msg");
    const recs = readRecords(path.join(dir, "ses-trace", "curator.jsonl"));
    const sevs = recs.map((r) => r.severity);
    // Original: both emitted. Mutants (no-op): records missing.
    expect(sevs).toContain("TRACE");
    expect(sevs).toContain("DEBUG");
    expect(recs).toHaveLength(2);
  });
});

// ─── Equivalent-mutant justification (NOT tested — documented) ───────────────
//
// The following survivors are genuine equivalents and are intentionally left
// in place:
//
// • L91 `if (env)` → `if (true)`: when env is undefined/empty (the only cases
//   where the branch differs), `Number(undefined|"")` is NaN → isFinite false
//   → falls through to the same `explicit ?? DEFAULT` result. No observable
//   difference.
//
// • L133 inner `catch { /* no prior roll */ }` BlockStatement → `{}`: the
//   block body is already only a comment; emptying it changes nothing.
//
// • L166 `if (traceId) persistentAttrs["trace.id"] = traceId` → `if (true)`:
//   when traceId is undefined the mutant sets `persistentAttrs["trace.id"] =
//   undefined`, but JSON.stringify omits undefined values → identical output.
//
// • L175 `if (!enabled) return` → `if (false) return`: when disabled, `write`
//   is the no-op sink (`() => undefined`), so continuing past the gate still
//   writes nothing. Identical observable behavior (no file, no throw).
