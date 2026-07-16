/**
 * fs-lock.test.ts — unit tests for the atomic-write + advisory file lock core.
 *
 * Covers (mutant-killing):
 *   - atomicWriteJson / atomicWriteJsonSync: nested dir creation, temp+rename,
 *     payload format, write-failure + mkdir-failure paths.
 *   - isPidAlive: alive / ESRCH / EPERM / unknown-error / invalid-pid branches.
 *   - withLock: acquire+run+release, fn-throw still releases, concurrent
 *     serialization, dead-owner reclaim, stale-lock reclaim (dead pid, old
 *     mtime, different host), timeout diagnostics, crafted-metadata edge cases.
 *
 * No process.chdir(); all file IO under an os.tmpdir() mkdtemp root.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { atomicWriteJson, atomicWriteJsonSync, isPidAlive, withLock } from "./fs-lock.js";

let root: string;

function setupSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fslock-"));
  root = dir;
  return dir;
}

function cleanupSandbox(): void {
  if (root && fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeLockFile(p: string, payload: Record<string, unknown>, mtimeSec: number): void {
  fs.writeFileSync(p, JSON.stringify(payload));
  fs.utimesSync(p, mtimeSec, mtimeSec);
}

beforeEach(() => setupSandbox());
afterEach(() => cleanupSandbox());

// ─── atomicWriteJson ────────────────────────────────────────────────────────

describe("atomicWriteJson", () => {
  it("writes pretty JSON with trailing newline to a nested path", async () => {
    const target = path.join(root, "a", "b", "out.json");
    await atomicWriteJson(target, { x: 1, list: [1, 2, 3] });
    const raw = fs.readFileSync(target, "utf8");
    expect(raw).toBe(JSON.stringify({ x: 1, list: [1, 2, 3] }, null, 2) + "\n");
  });

  it("creates intermediate directories", async () => {
    const target = path.join(root, "deep", "deeper", "file.json");
    await atomicWriteJson(target, { ok: true });
    expect(fs.existsSync(target)).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ ok: true });
  });

  it("leaves no leftover temp file after rename", async () => {
    const target = path.join(root, "x.json");
    await atomicWriteJson(target, { v: 9 });
    const temps = fs.readdirSync(root).filter((f) => f.includes(".tmp."));
    expect(temps).toEqual([]);
  });

  it("overwrites an existing target atomically", async () => {
    const target = path.join(root, "c.json");
    await atomicWriteJson(target, { v: 1 });
    await atomicWriteJson(target, { v: 2 });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ v: 2 });
  });

  it("rejects when the target path is not writable (e.g. parent is a file)", async () => {
    const blocker = path.join(root, "blocker");
    fs.writeFileSync(blocker, "I am a file");
    const target = path.join(blocker, "sub", "file.json");
    await expect(atomicWriteJson(target, { x: 1 })).rejects.toThrow();
  });
});

// ─── atomicWriteJsonSync ────────────────────────────────────────────────────

describe("atomicWriteJsonSync", () => {
  it("writes pretty JSON synchronously with trailing newline", () => {
    const target = path.join(root, "sync", "out.json");
    atomicWriteJsonSync(target, { n: 42 });
    const raw = fs.readFileSync(target, "utf8");
    expect(raw).toBe(JSON.stringify({ n: 42 }, null, 2) + "\n");
  });

  it("creates nested directories and renames temp", () => {
    const target = path.join(root, "s", "deep", "f.json");
    atomicWriteJsonSync(target, { a: 1 });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ a: 1 });
    expect(
      fs.readdirSync(path.join(root, "s", "deep")).some((f) => f.includes(".tmp.")),
    ).toBe(false);
  });

  it("overwrites existing target", () => {
    const target = path.join(root, "ov.json");
    atomicWriteJsonSync(target, { v: 1 });
    atomicWriteJsonSync(target, { v: 2 });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ v: 2 });
  });

  it("swallows mkdirSync failure then fails loudly on write (parent is a file)", () => {
    const blocker = path.join(root, "blk");
    fs.writeFileSync(blocker, "file");
    const target = path.join(blocker, "child.json");
    expect(() => atomicWriteJsonSync(target, { x: 1 })).toThrow();
  });
});

// ─── isPidAlive ─────────────────────────────────────────────────────────────

describe("isPidAlive", () => {
  it("returns true when kill succeeds (alive)", () => {
    const kill = viFn(() => {});
    expect(isPidAlive(100, kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(100, 0);
  });

  it("returns false on ESRCH (no such process)", () => {
    expect(isPidAlive(100, throwingKill("ESRCH"))).toBe(false);
  });

  it("returns true on EPERM (alive, no permission)", () => {
    expect(isPidAlive(100, throwingKill("EPERM"))).toBe(true);
  });

  it("returns true (conservative) on unknown errno code", () => {
    expect(isPidAlive(100, throwingKill("EACCES"))).toBe(true);
  });

  it("returns true (conservative) on a non-errno Error", () => {
    expect(isPidAlive(100, throwingKill(null, new Error("plain")))).toBe(true);
  });

  it("returns true (conservative) on a thrown non-object", () => {
    expect(isPidAlive(100, throwingKill(null, "string error"))).toBe(true);
  });

  it("returns false for non-integer pids", () => {
    const kill = viFn();
    expect(isPidAlive(1.5, kill)).toBe(false);
    expect(isPidAlive(0, kill)).toBe(false);
    expect(isPidAlive(-3, kill)).toBe(false);
    expect(isPidAlive(NaN, kill)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("uses the default process.kill for a live pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

// ─── withLock ───────────────────────────────────────────────────────────────

describe("withLock", () => {
  it("acquires, runs fn, returns its value, and releases the lock", async () => {
    const lock = path.join(root, "L.lock");
    const result = await withLock(lock, async () => 42, { label: "t1" });
    expect(result).toBe(42);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("writes holder metadata (pid/hostname/label) into the lock while held", async () => {
    const lock = path.join(root, "meta.lock");
    let seen: any = null;
    await withLock(
      lock,
      async () => {
        seen = JSON.parse(fs.readFileSync(lock, "utf8"));
        return undefined;
      },
      { label: "holder-A" },
    );
    expect(seen.pid).toBe(process.pid);
    expect(seen.hostname).toBe(os.hostname());
    expect(seen.label).toBe("holder-A");
    expect(typeof seen.createdAt).toBe("string");
  });

  it("releases the lock even when fn throws", async () => {
    const lock = path.join(root, "throw.lock");
    await expect(withLock(lock, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("serializes concurrent critical sections (mutual exclusion)", async () => {
    const lock = path.join(root, "serial.lock");
    const order: string[] = [];
    let inFlight = false;
    const make = (name: string) => async () => {
      expect(inFlight, `${name} overlapped`).toBe(false);
      inFlight = true;
      order.push(`start-${name}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end-${name}`);
      inFlight = false;
      return name;
    };
    const [a, b, c] = await Promise.all([
      withLock(lock, make("a")),
      withLock(lock, make("b")),
      withLock(lock, make("c")),
    ]);
    expect([a, b, c]).toEqual(["a", "b", "c"]);
    expect(order.filter((x) => x.startsWith("start")).length).toBe(3);
    expect(order.filter((x) => x.startsWith("end")).length).toBe(3);
  });

  it("reclaims a stale lock whose owner PID is dead", async () => {
    const lock = path.join(root, "dead.lock");
    writeLockFile(
      lock,
      { pid: 999_999, hostname: os.hostname(), createdAt: new Date().toISOString(), label: "ghost" },
      Date.now() / 1000,
    );
    const result = await withLock(lock, async () => "reclaimed", { timeoutMs: 1000 });
    expect(result).toBe("reclaimed");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("reclaims a stale lock whose age exceeds staleMs", async () => {
    const lock = path.join(root, "old.lock");
    const ancientSec = (Date.now() - 120_000) / 1000;
    writeLockFile(
      lock,
      { pid: 999_999, hostname: os.hostname(), createdAt: new Date(ancientSec * 1000).toISOString() },
      ancientSec,
    );
    const result = await withLock(lock, async () => "ok", { staleMs: 1000, timeoutMs: 2000 });
    expect(result).toBe("ok");
  });

  it("reclaims a stale lock when owner has no recorded pid", async () => {
    const lock = path.join(root, "noid.lock");
    const ancientSec = (Date.now() - 120_000) / 1000;
    writeLockFile(lock, { hostname: os.hostname(), createdAt: "x" }, ancientSec);
    const result = await withLock(lock, async () => "noid-ok", { staleMs: 1000, timeoutMs: 2000 });
    expect(result).toBe("noid-ok");
  });

  it("times out and throws a diagnostic error when the lock stays held by a live owner", async () => {
    const lock = path.join(root, "held.lock");
    writeLockFile(
      lock,
      { pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(), label: "busy" },
      Date.now() / 1000,
    );
    await expect(
      withLock(lock, async () => "never", { timeoutMs: 80, pollMs: 10, staleMs: 60_000 }),
    ).rejects.toThrow(/Timeout acquiring lock/);
  });

  it("reports the holder pid and label in the timeout error", async () => {
    const lock = path.join(root, "held2.lock");
    writeLockFile(
      lock,
      { pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(), label: "worker" },
      Date.now() / 1000,
    );
    await expect(
      withLock(lock, async () => "x", { timeoutMs: 40, pollMs: 5, staleMs: 60_000 }),
    ).rejects.toThrow(new RegExp(`pid=${process.pid}.*label=worker|label=worker.*pid=${process.pid}`));
  });

  it("times out for a different-host lock that is fresh", async () => {
    const lock = path.join(root, "remote.lock");
    writeLockFile(
      lock,
      { pid: 12345, hostname: "some-other-host", createdAt: new Date().toISOString(), label: "remote" },
      Date.now() / 1000,
    );
    await expect(
      withLock(lock, async () => "x", { timeoutMs: 50, pollMs: 5 }),
    ).rejects.toThrow(/Timeout acquiring lock/);
  });

  it("treats a lock with non-string hostname as same-host (default)", async () => {
    const lock = path.join(root, "nohost.lock");
    writeLockFile(
      lock,
      { pid: 888_888, hostname: 12345, createdAt: new Date().toISOString() },
      Date.now() / 1000,
    );
    const result = await withLock(lock, async () => "same-host", { timeoutMs: 1000 });
    expect(result).toBe("same-host");
  });

  it("handles a corrupt (non-JSON) lock file by falling through to wait/timeout", async () => {
    const lock = path.join(root, "corrupt.lock");
    fs.writeFileSync(lock, "{not valid json");
    fs.utimesSync(lock, Date.now() / 1000, Date.now() / 1000);
    await expect(
      withLock(lock, async () => "x", { timeoutMs: 40, pollMs: 5 }),
    ).rejects.toThrow(/Timeout acquiring lock/);
  });

  it("handles a non-object JSON lock (e.g. a bare array/number)", async () => {
    const lock = path.join(root, "arr.lock");
    fs.writeFileSync(lock, JSON.stringify([1, 2, 3]));
    fs.utimesSync(lock, Date.now() / 1000, Date.now() / 1000);
    await expect(
      withLock(lock, async () => "x", { timeoutMs: 40, pollMs: 5 }),
    ).rejects.toThrow(/Timeout acquiring lock/);
  });

  it("reclaims when metadata pid is a non-number (ownerAlive null) and lock is stale", async () => {
    const lock = path.join(root, "strpid.lock");
    const ancientSec = (Date.now() - 120_000) / 1000;
    writeLockFile(
      lock,
      { pid: "not-a-number", hostname: os.hostname(), createdAt: "x", label: "weird" },
      ancientSec,
    );
    const result = await withLock(lock, async () => "strpid-ok", { staleMs: 1000, timeoutMs: 2000 });
    expect(result).toBe("strpid-ok");
  });

  it("uses default option values when none are provided", async () => {
    const lock = path.join(root, "defaults.lock");
    const result = await withLock(lock, async () => "default-ok");
    expect(result).toBe("default-ok");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("rethrows a non-EEXIST open error (read-only directory)", async () => {
    if (process.getuid && process.getuid() === 0) return; // root bypasses perms
    const roDir = path.join(root, "readonly");
    fs.mkdirSync(roDir);
    fs.chmodSync(roDir, 0o555);
    const lock = path.join(roDir, "denied.lock");
    try {
      await expect(withLock(lock, async () => "x", { timeoutMs: 200 })).rejects.toThrow();
    } finally {
      fs.chmodSync(roDir, 0o755);
    }
  });

  it("timeout message omits the label substring when the holder lock has no label", async () => {
    const lock = path.join(root, "nolabel.lock");
    writeLockFile(
      lock,
      { pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() },
      Date.now() / 1000,
    );
    let msg = "";
    try {
      await withLock(lock, async () => "x", { timeoutMs: 40, pollMs: 5, staleMs: 60_000 });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("Timeout acquiring lock:");
    expect(msg).toContain(lock);
    expect(msg).toContain(`pid=${process.pid}`);
    // No label was recorded → the label substring MUST be absent (an
    // else-branch StringLiteral mutant would inject stray text here).
    expect(msg).not.toMatch(/label=/);
  });

  it("timeout message omits the pid substring when the holder lock has no pid", async () => {
    const lock = path.join(root, "nopid.lock");
    // Different-host, no pid → unreclaimable; times out.
    writeLockFile(
      lock,
      { hostname: "some-other-host", createdAt: new Date().toISOString(), label: "remote" },
      Date.now() / 1000,
    );
    let msg = "";
    try {
      await withLock(lock, async () => "x", { timeoutMs: 40, pollMs: 5 });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("Timeout acquiring lock:");
    expect(msg).toContain("label=remote");
    // No numeric pid recorded → the pid substring MUST be absent.
    expect(msg).not.toMatch(/pid=/);
  });
});

// ─── Mutation survivor remediation (final round) ────────────────────────────
// Each test below targets a specific Survived mutant in fs-lock.ts. See the
// accompanying remediation notes for the full equivalent-mutant justification.

describe("isPidAlive — isErrnoException null-guard (mutation survivors L26)", () => {
  // L26 ConditionalExpression survivors: when the injected kill throws `null`,
  // isErrnoException(null) is false (typeof null==="object" && null!==null → false).
  // A mutant that drops the null-check (or forces the expression true) makes
  // `"code" in null` throw a TypeError instead of returning the conservative
  // `true`. The function MUST swallow the nullish throw and return true.
  it("returns true (conservative) when kill throws null — no TypeError leak", () => {
    const killThrowingNull = (): void => {
      throw null;
    };
    expect(isPidAlive(100, killThrowingNull as (p: number, s: 0) => void)).toBe(true);
  });

  it("returns true (conservative) when kill throws undefined", () => {
    const killThrowingUndef = (): void => {
      throw undefined;
    };
    expect(isPidAlive(100, killThrowingUndef as (p: number, s: 0) => void)).toBe(true);
  });
});

describe("atomicWriteJson — `if (dir)` falsy-dir branch (mutation survivor L42)", () => {
  // L42 `if (dir)` → `if (true)`: when filePath has no "/", dir="". Original skips
  // mkdir; mutant calls mkdir("") which throws EINVAL. A bare filename MUST write
  // without mkdir. We clean up the cwd-relative artifact explicitly (no chdir).
  const bareNames: string[] = [];
  afterEach(() => {
    for (const n of bareNames) {
      try { fs.unlinkSync(n); } catch { /* ignore */ }
      try { fs.unlinkSync(`${n}.tmp.${process.pid}.${Date.now()}`); } catch { /* ignore */ }
    }
    bareNames.length = 0;
  });

  it("writes a bare (no-slash) filename without invoking mkdir", async () => {
    const name = `fslock-bare-async-${process.pid}-${Date.now()}.json`;
    bareNames.push(name);
    await atomicWriteJson(name, { flat: true });
    expect(JSON.parse(fs.readFileSync(name, "utf8"))).toEqual({ flat: true });
  });
});

describe("atomicWriteJsonSync — `if (dir)` falsy-dir branch (mutation survivor L54)", () => {
  const bareNames: string[] = [];
  afterEach(() => {
    for (const n of bareNames) {
      try { fs.unlinkSync(n); } catch { /* ignore */ }
    }
    bareNames.length = 0;
  });

  it("writes a bare (no-slash) filename without invoking mkdirSync", () => {
    const name = `fslock-bare-sync-${process.pid}-${Date.now()}.json`;
    bareNames.push(name);
    atomicWriteJsonSync(name, { flat: 7 });
    expect(JSON.parse(fs.readFileSync(name, "utf8"))).toEqual({ flat: 7 });
  });
});

describe("withLock — label ternary (mutation survivor L121)", () => {
  // L121 `typeof p.label === "string" ? p.label : undefined` → always `p.label`:
  // a non-string label (e.g. number) would leak into the timeout message as
  // `label=123`. The receiver MUST coerce non-strings to undefined so the label
  // substring is omitted.
  it("omits the label substring when the holder lock records a non-string label", async () => {
    const lock = path.join(root, "nonstrlabel.lock");
    writeLockFile(
      lock,
      // label is a number, pid alive → unreclaimable → times out.
      { pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(), label: 12345 },
      Date.now() / 1000,
    );
    let msg = "";
    try {
      await withLock(lock, async () => "x", { timeoutMs: 40, pollMs: 5, staleMs: 60_000 });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("Timeout acquiring lock:");
    // Non-string label MUST be coerced away — no `label=` substring may appear.
    expect(msg).not.toMatch(/label=/);
  });
});

describe("withLock — staleMs default (mutation survivor L144)", () => {
  // L144 `opts.staleMs ?? 60_000` → `opts.staleMs && 60_000`: when the caller
  // supplies a small staleMs, a stale remote-host lock (ownerAlive null) MUST be
  // reclaimed. Under the mutant the default 60s is used instead, so a 30s-old
  // remote lock is NOT reclaimed → timeout instead of success.
  it("reclaims a 30s-old remote-host lock when staleMs is small", async () => {
    const lock = path.join(root, "stalems.lock");
    const oldSec = (Date.now() - 30_000) / 1000;
    writeLockFile(
      lock,
      { pid: 4242, hostname: "remote-host-xyz", createdAt: new Date(oldSec * 1000).toISOString(), label: "r" },
      oldSec,
    );
    const result = await withLock(lock, async () => "reclaimed-by-stalems", {
      staleMs: 1_000,
      timeoutMs: 2_000,
    });
    expect(result).toBe("reclaimed-by-stalems");
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe("withLock — non-EEXIST errno rethrow + cause (mutation survivors L183/L184)", () => {
  // L183 LogicalOperator (`||`→`&&`) + L183 ConditionalExpression (cond→false):
  // a non-EEXIST errno (EACCES on a read-only dir) MUST be rethrown as a wrapped
  // error whose message carries the original errno — NOT a generic "Timeout".
  // Under the mutants the EACCES falls through to the wait loop and surfaces as
  // "Timeout acquiring lock".
  it("rethrows an EACCES open error with the errno in the message (not a timeout)", async () => {
    if (process.getuid && process.getuid() === 0) return; // root bypasses perms
    const roDir = path.join(root, "ro-errno");
    fs.mkdirSync(roDir);
    fs.chmodSync(roDir, 0o555);
    const lock = path.join(roDir, "denied.lock");
    try {
      let caught: unknown;
      try {
        await withLock(lock, async () => "x", { timeoutMs: 300, pollMs: 10 });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      // The wrapped message MUST carry the original errno / permission text.
      expect(msg).toMatch(/EACCES|permission|denied/i);
      // It must NOT be the generic timeout fallback the mutants produce.
      expect(msg).not.toMatch(/Timeout acquiring lock/);
      // L184 ObjectLiteral `{ cause: err }` → `{}`: the cause MUST be preserved.
      expect((caught as Error).cause).toBeDefined();
    } finally {
      fs.chmodSync(roDir, 0o755);
    }
  });
});

describe("withLock — optional-chaining on metadata (mutation survivors L192/L193)", () => {
  // L192 `metadata?.hostname` and L193 `metadata?.pid`: when the lock file is
  // corrupt (non-JSON) readLockMetadata returns null. A stale corrupt lock MUST
  // still be reclaimed (sameHost defaults true, ownerAlive null, stale → reclaim).
  // Under the mutants `metadata.hostname` throws on null → caught → no reclaim →
  // the call times out instead of succeeding.
  it("reclaims a stale corrupt (non-JSON) lock file", async () => {
    const lock = path.join(root, "stalecorrupt.lock");
    fs.writeFileSync(lock, "{not valid json");
    const oldSec = (Date.now() - 120_000) / 1000;
    fs.utimesSync(lock, oldSec, oldSec);
    const result = await withLock(lock, async () => "reclaimed-corrupt", {
      staleMs: 1_000,
      timeoutMs: 2_000,
    });
    expect(result).toBe("reclaimed-corrupt");
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe("withLock — stale-but-live-owner must NOT be reclaimed (mutation survivors L195)", () => {
  // L195 ConditionalExpression (ownerAlive!==true → true) + L195 BooleanLiteral
  // (true→false making it ownerAlive!==false): a stale lock whose owner is ALIVE
  // must NOT be reclaimed — the loop waits and times out. Under the mutants the
  // stale+live lock is wrongly reclaimed → the call succeeds instead of throwing.
  it("times out (does NOT reclaim) a stale lock owned by a live pid", async () => {
    const lock = path.join(root, "stalelive.lock");
    const oldSec = (Date.now() - 120_000) / 1000;
    writeLockFile(
      lock,
      { pid: process.pid, hostname: os.hostname(), createdAt: new Date(oldSec * 1000).toISOString(), label: "alive" },
      oldSec,
    );
    await expect(
      withLock(lock, async () => "should-not-happen", { staleMs: 1_000, timeoutMs: 60, pollMs: 10 }),
    ).rejects.toThrow(/Timeout acquiring lock/);
  });
});

describe("withLock — timeout error preserves cause (mutation survivor L210)", () => {
  // L210 ObjectLiteral `{ cause: err }` → `{}`: the timeout Error MUST carry the
  // original EEXIST error as `.cause`.
  it("the timeout Error carries the original EEXIST as .cause", async () => {
    const lock = path.join(root, "cause.lock");
    writeLockFile(
      lock,
      { pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(), label: "busy" },
      Date.now() / 1000,
    );
    let caught: unknown;
    try {
      await withLock(lock, async () => "x", { timeoutMs: 40, pollMs: 5, staleMs: 60_000 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Timeout acquiring lock/);
    expect((caught as Error).cause).toBeDefined();
    // The cause is the original EEXIST errno exception.
    expect(((caught as Error).cause as NodeJS.ErrnoException).code).toBe("EEXIST");
  });
});

describe("withLock — release path closes the fd (mutation survivors L226/L227)", () => {
  // L226 BlockStatement (empty try) + L227 ConditionalExpression (fd!==null →
  // false) + L227 EqualityOperator (!== → ===): on a normal acquire+release the
  // fd MUST be closed. We can't spy on fs.closeSync (ESM namespace), so we detect
  // a leaked fd via /proc/self/fd: each skipped close leaks one descriptor, so
  // after several acquires the open-fd count MUST return to baseline.
  function openFdCount(): number {
    try {
      return fs.readdirSync("/proc/self/fd").length;
    } catch {
      return -1; // non-Linux → skip assertion gracefully
    }
  }

  it("closes the acquired fd on every release (no fd leak)", async () => {
    const before = openFdCount();
    if (before < 0) return; // platform without /proc/self/fd
    for (let i = 0; i < 6; i++) {
      const lock = path.join(root, `closefd-${i}.lock`);
      await withLock(lock, async () => `done-${i}`, { label: `closefd-${i}` });
    }
    const after = openFdCount();
    // The mutants leak +1 fd per acquire (6 total). Allow a small margin for
    // unrelated concurrent descriptor churn, but a 5+ jump is a real leak.
    expect(after - before).toBeLessThan(5);
  });
});

describe("withLock — backoff timing (mutation survivors L213-L218)", () => {
  // The exponential-backoff + jitter math only affects the SLEEP DURATION, never
  // the acquire/timeout outcome. We assert the FIRST backoff sleep lands in the
  // expected range for basePollMs=100 so the arithmetic mutants (which move the
  // first delay out of band) are detected. A fresh lock held by a live owner is
  // unreclaimable, so the loop reliably reaches the sleep branch.
  it("first backoff sleep for basePollMs=100 lands in [90,400]ms", async () => {
    const lock = path.join(root, "backoff.lock");
    writeLockFile(
      lock,
      { pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(), label: "bk" },
      Date.now() / 1000,
    );
    const delays: number[] = [];
    const realSetTimeout = setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms?: number) => {
      if (typeof ms === "number") delays.push(ms);
      return realSetTimeout(fn, ms);
    });
    try {
      await expect(
        withLock(lock, async () => "x", { timeoutMs: 2_000, pollMs: 100, staleMs: 60_000 }),
      ).rejects.toThrow(/Timeout acquiring lock/);
    } finally {
      spy.mockRestore();
    }
    expect(delays.length).toBeGreaterThan(0);
    // Original first delay ∈ [100,300]. Mutants move it to ≤75 or ≥500 or 1.
    expect(delays[0]).toBeGreaterThanOrEqual(90);
    expect(delays[0]).toBeLessThanOrEqual(400);
  });
});

function viFn(impl?: (...a: any[]) => any) {
  return vi.fn(impl);
}
function throwingKill(code: string | null, err?: unknown): (pid: number, sig: 0) => void {
  return () => {
    if (err !== undefined) throw err;
    const e = new Error("x") as NodeJS.ErrnoException;
    e.code = code!;
    throw e;
  };
}
