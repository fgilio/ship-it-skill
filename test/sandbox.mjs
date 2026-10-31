// A sandbox per test: a fake gh on PATH, its state file, and its call log.

import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptsDirectory = join(repositoryDirectory, "scripts");
const fakeGhSource = join(
  repositoryDirectory,
  "test",
  "fixtures",
  "fake-gh.mjs",
);

export function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), "ship-it-test-"));
  const binDirectory = join(root, "bin");

  mkdirSync(binDirectory);
  copyFileSync(fakeGhSource, join(binDirectory, "gh"));
  chmodSync(join(binDirectory, "gh"), 0o755);

  const sandbox = {
    root,
    statePath: join(root, "state.json"),
    logPath: join(root, "gh-calls.jsonl"),
    binDirectory,
    writeState(state) {
      writeFileSync(sandbox.statePath, JSON.stringify(state));
    },
    ghCalls() {
      return existsSync(sandbox.logPath)
        ? readFileSync(sandbox.logPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    },
    runScript(script, args, env = {}) {
      return new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [join(scriptsDirectory, script), ...args],
          {
            env: {
              ...process.env,
              PATH: `${binDirectory}:${process.env.PATH}`,
              FAKE_GH_STATE: sandbox.statePath,
              FAKE_GH_LOG: sandbox.logPath,
              ...env,
            },
          },
        );
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };

  return sandbox;
}
