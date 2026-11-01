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
import { join } from "node:path";

import type { FakeState } from "./fixtures/fake-gh";

const repositoryDirectory = join(import.meta.dir, "..");
const scriptsDirectory = join(repositoryDirectory, "scripts");
const fakeGhSource = join(import.meta.dir, "fixtures", "fake-gh.ts");

export interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  root: string;
  writeState(state: FakeState): void;
  ghCalls(): string[][];
  runScript(
    script: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<ScriptResult>;
  remove(): void;
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "ship-it-test-"));
  const binDirectory = join(root, "bin");
  const statePath = join(root, "state.json");
  const logPath = join(root, "gh-calls.jsonl");

  mkdirSync(binDirectory);
  copyFileSync(fakeGhSource, join(binDirectory, "gh"));
  chmodSync(join(binDirectory, "gh"), 0o755);

  return {
    root,
    writeState(state) {
      writeFileSync(statePath, JSON.stringify(state));
    },
    ghCalls() {
      if (!existsSync(logPath)) {
        return [];
      }

      return readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line))
        .filter(isStringList);
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
              FAKE_GH_STATE: statePath,
              FAKE_GH_LOG: logPath,
              ...env,
            },
          },
        );
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
