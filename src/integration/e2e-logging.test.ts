/**
 * e2e-logging.test.ts — vitest wrapper around the e2e-logging.ts script so the
 * proof that all 4 components emit OTel logs is part of the normal test suite.
 *
 * It runs the e2e script as a child process and asserts the stdout contains
 * the success marker. Keeps the script standalone (for manual inspection)
 * while gating CI on its output.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as path from "node:path";

const SCRIPT = path.resolve(__dirname, "e2e-logging.ts");

describe("pi-curator OTel e2e — all 4 components wire to real log files", () => {
  it("main, runtime, janitor, receiver all emit OTel records; trace.id propagates", () => {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("npx", ["tsx", SCRIPT], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: path.resolve(__dirname, "../.."),
        timeout: 60000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          return reject(
            new Error(`e2e-logging.ts exited with ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`),
          );
        }
        // Assert every scope shows up in the summary table.
        for (const scope of ["curator.main", "curator.runtime", "curator.janitor", "curator.receiver"]) {
          if (!stdout.includes(scope)) {
            return reject(new Error(`e2e output missing scope '${scope}'\nstdout:\n${stdout}`));
          }
        }
        // Assert the success marker.
        if (!stdout.includes("ALL 4 COMPONENTS EMITTING OTel LOGS")) {
          return reject(new Error(`e2e success marker missing\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }
        // Assert trace.id propagation was exercised.
        if (!stdout.includes("trace.id (main→runtime):")) {
          return reject(new Error(`e2e trace.id propagation check missing\nstdout:\n${stdout}`));
        }
        resolve();
      });
    });
  }, 90_000);
});
