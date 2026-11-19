import { describe, expect, test } from "bun:test";

import { parseReviewDescription } from "../scripts/lib";

describe("parseReviewDescription", () => {
  test.each([
    [null, { focus: null, default: false }],
    ["", { focus: null, default: false }],
    ["[correctness] Bugs", { focus: "correctness", default: false }],
    ["[cleanup] [default] Simplify", { focus: "cleanup", default: true }],
    [
      "[default] [maintainability] Style",
      { focus: "maintainability", default: true },
    ],
    ["Bugs [Correctness] [DEFAULT]", { focus: "correctness", default: true }],
    ["[default] Untagged", { focus: null, default: true }],
    ["[security] [default] Unknown focus", { focus: null, default: true }],
    ["[correctness] Use the default", { focus: "correctness", default: false }],
    ["[correctness] [defaults]", { focus: "correctness", default: false }],
    [
      "[correctness] [default-review]",
      { focus: "correctness", default: false },
    ],
  ])("parses %j", (description, expected) => {
    expect(parseReviewDescription(description)).toEqual(expected);
  });
});
