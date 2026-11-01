#!/usr/bin/env bun
// Lists the review labels a repository offers, by focus.

import {
  FOCUS_ORDER,
  ScriptError,
  ghRecords,
  main,
  parseArguments,
  parseFocus,
  parseReviewLabel,
  printJson,
  resolveRepository,
  stringOrNull,
} from "./lib";

const USAGE = `Usage: ship-it-review-list.ts [--repo owner/name]

Lists, as JSON, every label of the repository that requests a review from
a review service (\`<service>-review:<kind>\`) and whose description tags
its focus: [correctness], [cleanup] or [maintainability]. Ordered by focus,
then by label. A label without a focus tag is left out.

Options:
  --repo owner/name   The repository (default: the current directory's)
`;

await main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    valueFlags: ["repo"],
  });

  if (positionals.length > 0) {
    throw new ScriptError(
      `ship-it-review-list.ts takes no arguments.\n\n${USAGE}`,
    );
  }

  const repository = resolveRepository(flags.repo);

  const reviewLabels = ghRecords(`repos/${repository}/labels?per_page=100`)
    .flatMap(({ name, description }) => {
      const label = String(name);
      const parsed = parseReviewLabel(label);
      const focus = parseFocus(stringOrNull(description));

      return parsed && focus
        ? [{ label, service: parsed.service, kind: parsed.kind, focus }]
        : [];
    })
    .toSorted(
      (a, b) =>
        FOCUS_ORDER.indexOf(a.focus) - FOCUS_ORDER.indexOf(b.focus) ||
        a.label.localeCompare(b.label),
    );

  printJson(reviewLabels);
});
