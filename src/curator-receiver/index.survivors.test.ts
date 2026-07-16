/**
 * curator-receiver/index.survivors.test.ts — final-round mutation survivor
 * coverage for src/curator-receiver/index.ts.
 *
 * Target:
 *  - L59 OptionalChaining (`ctx?.sessionId ?? ctx?.session?.id` → removes `?.`
 *    on session): when ctx has NEITHER sessionId NOR session, the original
 *    resolves sessionId=undefined and still processes; the mutant throws.
 *
 * Equivalent survivors (documented):
 *  - L47 ArrayDeclaration (initial `knownCurators = []`): getCachedConfig never
 *    throws (REQ-CF-09 degrades to empty), so knownCurators is ALWAYS reassigned
 *    by Object.keys(enabledPersonas(...)) — the initial value is dead.
 *  - L61 ConditionalExpression→false (ctx.sendMessage typeof check): the bound
 *    ctxAdapter.sendMessage is never read by processIncoming (it uses
 *    pi.sendMessage) — dead field.
 *  - L64/L78 OptionalChaining notify: wrapped in try/catch (REQ-SG-09).
 */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { clearConfigCache } from "../util/config.js";

const REAL_ENV = { ...process.env };

function writeProjectConfig(projectRoot: string, aliases: string[]) {
  const dir = path.join(projectRoot, ".pi-curator");
  fs.mkdirSync(dir, { recursive: true });
  const curators: Record<string, unknown> = {};
  for (const a of aliases) curators[a] = { alias: a, enabled: true };
  fs.writeFileSync(
    path.join(dir, "curators.json"),
    JSON.stringify({ curators }, null, 2),
    "utf8",
  );
}

describe("curator-receiver entry — ctx.session.id fallback chain (L59)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crx-l59-"));
    writeProjectConfig(projectRoot, ["spec"]);
    clearConfigCache();
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    process.env = { ...REAL_ENV };
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("processes a known curator when ctx has neither sessionId nor session (kills L59 session?. mutant)", async () => {
    // ctx = { cwd } only — no sessionId, no session. Original:
    //   sessionId = ctx?.sessionId ?? ctx?.session?.id = undefined ?? undefined = undefined
    //   → processIncoming proceeds (absent session id is not a mismatch).
    // Mutant L59 (`ctx?.session.id`): throws → outer catch → no re-delivery.
    const mod = await import("./index");
    const sendMessage = vi.fn();
    const pi: any = { on: vi.fn(), sendMessage };
    const ctx: any = { cwd: projectRoot }; // no sessionId, no session
    mod.default(pi, ctx);
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "message_start")[1];

    const event = {
      message: {
        customType: "intercom_message",
        content: "**📨 From spec** (/p)\n\n[STEER] body",
        details: { from: { name: "spec", id: "id-spec" }, bodyText: "[STEER] body" },
      },
    };
    expect(() => handler(event, ctx)).not.toThrow();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
