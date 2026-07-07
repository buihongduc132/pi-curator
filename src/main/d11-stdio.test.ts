/**
 * d11-stdio.test.ts — RED phase tests for D11 stderr capture.
 *
 * Design decision D11 (openspec/changes/archive/2026-06-23-add-curator-lifecycle/design.md):
 *   stdio: ['ignore', fs.openSync('/dev/null','w'), fs.openSync('<log>','a')]
 *   log path: ~/.pi-curator/logs/<mainSessionId>/<curator>-<ts>.stderr
 *   janitor GCs @ 24h
 *
 * These tests import `resolveStdio` from spawn-args — a pure function that
 * does NOT exist yet. Tests MUST FAIL until GREEN implements it.
 *
 * @see {@link file://./spawn-args.ts}
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// This import will fail until resolveStdio is implemented in spawn-args.ts.
import { resolveStdio } from "./spawn-args.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-curator-d11-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveStdio (D11)", () => {
  it("returns a 3-element array ['ignore', Writable, Writable]", () => {
    const result = resolveStdio({
      mainSessionId: "sess-abc",
      curatorAlias: "spec",
      nowMs: 1700000000000,
      logsBaseDir: tmpDir,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("ignore");
    // result[1] and result[2] should be writable file descriptors (numbers)
    expect(typeof result[1]).toBe("number");
    expect(typeof result[2]).toBe("number");
  });

  it("stdout (index 1) writes to /dev/null (discarded)", () => {
    const result = resolveStdio({
      mainSessionId: "sess-abc",
      curatorAlias: "spec",
      nowMs: 1700000000000,
      logsBaseDir: tmpDir,
    });

    // stdout fd should point to /dev/null — writing to it should succeed
    // and produce no output. We verify by checking the fd is valid.
    const stdoutFd = result[1] as number;
    expect(() => {
      fs.writeSync(stdoutFd, "discarded\n");
    }).not.toThrow();

    // Clean up fds
    fs.closeSync(stdoutFd);
    fs.closeSync(result[2] as number);
  });

  it("stderr (index 2) writes to the resolved log path", () => {
    const result = resolveStdio({
      mainSessionId: "sess-abc",
      curatorAlias: "spec",
      nowMs: 1700000000000,
      logsBaseDir: tmpDir,
    });

    const stderrFd = result[2] as number;
    const testMessage = "test diagnostic output\n";
    fs.writeSync(stderrFd, testMessage);

    // Close fd so we can read the file
    fs.closeSync(stderrFd);
    fs.closeSync(result[1] as number);

    // Verify the log file exists at the expected path
    const expectedLogPath = path.join(
      tmpDir,
      "sess-abc",
      "spec-1700000000000.stderr",
    );
    expect(fs.existsSync(expectedLogPath)).toBe(true);
    expect(fs.readFileSync(expectedLogPath, "utf8")).toBe(testMessage);
  });

  it("log path format: <logsBaseDir>/<mainSessionId>/<curator>-<ts>.stderr", () => {
    const result = resolveStdio({
      mainSessionId: "my-session-123",
      curatorAlias: "reviewer",
      nowMs: 1720000000000,
      logsBaseDir: tmpDir,
    });

    // Close the fds
    fs.closeSync(result[1] as number);
    fs.closeSync(result[2] as number);

    const expectedPath = path.join(
      tmpDir,
      "my-session-123",
      "reviewer-1720000000000.stderr",
    );
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("creates the logs directory if it doesn't exist (mkdir -p semantics)", () => {
    const deepDir = path.join(tmpDir, "deep", "nested", "logs");
    expect(fs.existsSync(deepDir)).toBe(false);

    const result = resolveStdio({
      mainSessionId: "sess-new",
      curatorAlias: "test-curator",
      nowMs: 1700000000000,
      logsBaseDir: deepDir,
    });

    // Directory should now exist
    expect(fs.existsSync(path.join(deepDir, "sess-new"))).toBe(true);

    // Clean up fds
    fs.closeSync(result[1] as number);
    fs.closeSync(result[2] as number);
  });

  it("uses ~/.pi-curator/logs as default logsBaseDir when not provided", () => {
    // We can't easily test the real home dir, but we can verify the function
    // accepts the call without logsBaseDir and produces a path containing
    // the expected default pattern.
    const result = resolveStdio({
      mainSessionId: "sess-default",
      curatorAlias: "default-test",
      nowMs: 1700000000000,
    });

    // Close fds — the function should have created the dirs and opened files
    fs.closeSync(result[1] as number);
    fs.closeSync(result[2] as number);

    // The default base dir should be ~/.pi-curator/logs
    const expectedDefault = path.join(
      os.homedir(),
      ".pi-curator",
      "logs",
      "sess-default",
      "default-test-1700000000000.stderr",
    );
    expect(fs.existsSync(expectedDefault)).toBe(true);

    // Clean up
    fs.rmSync(path.join(os.homedir(), ".pi-curator", "logs", "sess-default"), {
      recursive: true,
      force: true,
    });
  });
});
