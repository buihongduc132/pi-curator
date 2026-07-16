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
