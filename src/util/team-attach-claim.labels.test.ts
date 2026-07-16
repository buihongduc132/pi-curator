/**
 * team-attach-claim.labels.test.ts — kills the withLock `label` ObjectLiteral
 * mutants in src/util/team-attach-claim.ts (ids 2983/3002/3025/3039).
 *
 * The `label` passed to withLock is written into the advisory-lock metadata
 * payload via the numeric-fd `fs.writeFileSync(fd, JSON.stringify(payload))`
 * call. We capture that exact write by mocking `node:fs` (ESM namespaces cannot
 * be spied directly) and delegating every other call to the real fs, mirroring
 * the fs-lock.internals.test.ts pattern. SEPARATE file so the mock does not
 * disturb the real-fs tests in team-attach-claim.survivors.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const payloads: string[] = [];

vi.mock("node:fs", async (importActual) => {
  const actual = (await importActual()) as typeof import("node:fs");
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => {
      // The lock-metadata write is the only writeFileSync with a numeric fd
      // whose body is a JSON string. Capture it.
      if (typeof args[0] === "number" && typeof args[1] === "string") {
        payloads.push(args[1]);
      }
      return (actual.writeFileSync as unknown as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const {
  acquireCuratorClaim,
  heartbeatCuratorClaim,
  releaseCuratorClaim,
  seedCuratorPid,
} = await import("./team-attach-claim.js");

let tmp: string;
beforeEach(() => {
  payloads.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tac-label-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function lastPayload(): string {
  const p = payloads[payloads.length - 1];
  if (!p) throw new Error("no metadata payload write captured");
  return p;
}

describe("curator-claim functions emit their withLock label in the metadata", () => {
  it("acquireCuratorClaim label", async () => {
    const filePath = path.join(tmp, "acquire", "claim.json");
    await acquireCuratorClaim(filePath, { pid: 1, mainSessionId: "ses", curator: "c" });
    expect(lastPayload()).toContain("curator-claim:acquire:ses/c");
  });

  it("heartbeatCuratorClaim label", async () => {
    const filePath = path.join(tmp, "heartbeat", "claim.json");
    await heartbeatCuratorClaim(filePath, 7, { nowMs: 1_750_000_000_000 });
    expect(lastPayload()).toContain("curator-claim:heartbeat:7");
  });

  it("releaseCuratorClaim label", async () => {
    const filePath = path.join(tmp, "release", "claim.json");
    await releaseCuratorClaim(filePath, 9, { force: true });
    expect(lastPayload()).toContain("curator-claim:release:9");
  });

  it("seedCuratorPid label", async () => {
    const filePath = path.join(tmp, "seed", "claim.json");
    await seedCuratorPid(filePath, 11, { nowMs: 1_750_000_000_000 });
    expect(lastPayload()).toContain("curator-claim:seed:11");
  });
});
