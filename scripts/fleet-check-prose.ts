#!/usr/bin/env bun
// Runs the hub's prose check at the commit CI pins, as CI's docs job does.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ScriptError, main } from "./lib";

const ROOT = join(import.meta.dir, "..");
const HUB = "https://github.com/fgilio/claude-plugins.git";
// CI checks the hub out here too, and .gitignore keeps it out of the checks.
const CHECKOUT = join(ROOT, ".fleet");
const PIN =
  /fgilio\/claude-plugins\/\.github\/workflows\/fleet-ci\.yml@([0-9a-f]{40})/;

function git(args: readonly string[]): { ok: boolean; output: string } {
  const result = spawnSync("git", ["-C", CHECKOUT, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });

  return {
    ok: result.status === 0,
    output: (result.stdout || result.stderr || String(result.error)).trim(),
  };
}

await main(async () => {
  const workflow = join(ROOT, ".github/workflows/ci.yml");
  const pin = (await Bun.file(workflow).text()).match(PIN)?.[1];

  if (pin === undefined) {
    throw new ScriptError(
      `${workflow} pins no commit of the hub's fleet-ci.yml, so the prose check has no version to run.`,
    );
  }

  // A checkout at the pin with a file changed or gone would run another check.
  const intact =
    git(["rev-parse", "HEAD"]).output === pin &&
    git(["status", "--porcelain"]).output === "";

  if (!intact) {
    rmSync(CHECKOUT, { recursive: true, force: true });
    mkdirSync(CHECKOUT);

    for (const args of [
      ["init", "--quiet"],
      ["fetch", "--quiet", "--depth", "1", HUB, pin],
      ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
    ]) {
      const step = git(args);

      if (!step.ok) {
        throw new ScriptError(
          `Unable to fetch the hub at ${pin}, whose prose check CI runs: ${step.output}\nRun bun run check:prose again once github.com answers.`,
        );
      }
    }
  }

  const check = spawnSync("bun", [join(CHECKOUT, "scripts/check-prose.ts")], {
    cwd: ROOT,
    stdio: "inherit",
  });

  process.exit(check.status ?? 1);
});
