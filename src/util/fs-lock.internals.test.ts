/**
 * fs-lock.internals.test.ts — covers the withLock metadata-write failure branch
 * that cannot be triggered with a real filesystem:
 *   openSync(wx) succeeds, but writeFileSync(fd, payload) throws. Production
 *   closes the fd, unlinks the empty lock, and rethrows a wrapped Error.
 *
 * Uses vi.mock("node:fs") with a partial factory that forces writeFileSync to
 * fail only for numeric-fd writes (the metadata write). SEPARATE from
 * fs-lock.test.ts so the module mock does not disturb real-fs tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let failFdWrite = false;

vi.mock("node:fs", async (importActual) => {
  const actual = (await importActual()) as typeof import("node:fs");
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => {
      if (failFdWrite && typeof args[0] === "number") {
        throw new Error("disk full");
      }
      return (actual.writeFileSync as unknown as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const { withLock } = await import("./fs-lock.js");

let root: string;

beforeEach(() => {
  failFdWrite = false;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fslock-mock-"));
});
afterEach(() => {
  failFdWrite = false;
  if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});

describe("withLock — metadata write failure", () => {
  it("closes fd, removes the lock, and rethrows when the metadata write fails", async () => {
    const lock = path.join(root, "metafail.lock");
    failFdWrite = true;
    await expect(withLock(lock, async () => "x")).rejects.toThrow("disk full");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("still acquires normally once the write failure is lifted", async () => {
    const lock = path.join(root, "ok.lock");
    failFdWrite = true;
    await expect(withLock(lock, async () => "x")).rejects.toThrow("disk full");
    expect(fs.existsSync(lock)).toBe(false);
    failFdWrite = false;
    const result = await withLock(lock, async () => "recovered");
    expect(result).toBe("recovered");
    expect(fs.existsSync(lock)).toBe(false);
  });

  // L167 BlockStatement (empty try) — the metadata-write-failure handler MUST
  // close the now-open fd before unlinking. We spy on closeSync to assert it is
  // called with a numeric fd; the mutant empties the block and skips the close.
  it("closes the fd in the metadata-write-failure cleanup path", async () => {
    const lock = path.join(root, "metafailclose.lock");
    const closeSpy = vi.spyOn(fs, "closeSync");
    failFdWrite = true;
    try {
      await expect(withLock(lock, async () => "x")).rejects.toThrow("disk full");
      const numericCalls = closeSpy.mock.calls.filter((c) => typeof c[0] === "number");
      expect(numericCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      failFdWrite = false;
      closeSpy.mockRestore();
    }
  });

  // L178 ObjectLiteral `{ cause: writeErr }` → `{}`: the rethrown Error MUST
  // carry the original write error as `.cause`.
  it("preserves the write error as .cause on the rethrown metadata-write error", async () => {
    const lock = path.join(root, "metafailcause.lock");
    failFdWrite = true;
    let caught: unknown;
    try {
      await withLock(lock, async () => "x");
    } catch (e) {
      caught = e;
    }
    failFdWrite = false;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("disk full");
    expect((caught as Error).cause).toBeDefined();
    expect((caught as Error).cause).toBeInstanceOf(Error);
    expect(((caught as Error).cause as Error).message).toBe("disk full");
  });
});
