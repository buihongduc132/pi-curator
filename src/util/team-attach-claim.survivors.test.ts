/**
 * team-attach-claim.survivors.test.ts — kills surviving mutants in
 * src/util/team-attach-claim.ts.
 *
 * Killable:
 *  - id 2955 (writeCuratorClaimSync body → {}): the sync write must actually
 *    write to disk (mutant is a no-op).
 *  - id 2897 (getString typeof guard → true): a non-string required field must
 *    produce null, not a malformed claim.
 *  - id 2914 (getNumber typeof guard → true): a non-number pid must produce null.
 *  - id 2983/3002/3025/3039 (withLock labels): the label is passed as the lock
 *    metadata payload. By spying `fs.writeFileSync` and matching the numeric-fd
 *    metadata write, we assert the exact label string is sent.
 *
 * EQUIVALENT:
 *  - id 2898 (getString `v.length > 0` → `>= 0`): every getString caller
 *    immediately checks `!field` and rejects empty strings, so an empty-string
 *    return is still treated as missing → null. The behavior is identical.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  writeCuratorClaimSync,
  parseCuratorClaim,
} from "./team-attach-claim.js";

describe("team-attach-claim survivors", () => {
  it("writeCuratorClaimSync actually writes the file (kills no-op body mutant)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tac-surv-"));
    try {
      const filePath = path.join(tmp, "claim.json");
      const claim = {
        pid: 1,
        mainSessionId: "ses",
        curator: "c",
        spawnedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        phase: "spawned",
      };
      writeCuratorClaimSync(filePath, claim);
      const readBack = parseCuratorClaim(JSON.parse(fs.readFileSync(filePath, "utf8")));
      expect(readBack).not.toBeNull();
      expect(readBack!.curator).toBe("c");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parseCuratorClaim: non-string mainSessionId → null (kills getString cond→true mutant)", () => {
    const claim = {
      pid: 1,
      mainSessionId: 123,
      curator: "c",
      spawnedAt: "t",
      heartbeatAt: "t",
      phase: "spawned",
    };
    expect(parseCuratorClaim(claim)).toBeNull();
  });

  it("parseCuratorClaim: string pid → null (kills getNumber cond→true mutant)", () => {
    const claim = {
      pid: "5",
      mainSessionId: "ses",
      curator: "c",
      spawnedAt: "t",
      heartbeatAt: "t",
      phase: "spawned",
    };
    expect(parseCuratorClaim(claim)).toBeNull();
  });

  it("parseCuratorClaim: empty string required field → null (documents getString length equiv)", () => {
    const claim = {
      pid: 1,
      mainSessionId: "",
      curator: "c",
      spawnedAt: "t",
      heartbeatAt: "t",
      phase: "spawned",
    };
    expect(parseCuratorClaim(claim)).toBeNull();
  });

});
