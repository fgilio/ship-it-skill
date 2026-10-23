#!/usr/bin/env node
// Lists the review labels a repository offers, by focus.

import {
  FOCUS_ORDER,
  ReviewError,
  ghList,
  main,
  parseArguments,
  parseFocus,
  parseReviewLabel,
  printJson,
  resolveRepository,
} from "./lib.mjs";

const USAGE = `Usage: ship-it-review-list.mjs [--repo owner/name]

Lists, as JSON, every label of the repository that requests a review from
a review service (\`<service>-review:<kind>\`) and whose description tags
its focus: [correctness], [cleanup] or [maintainability]. Ordered by focus,
then by label. A label without a focus tag is left out.

Options:
  --repo owner/name   The repository (default: the current directory's)
`;

main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    valueFlags: ["repo"],
  });

  if (positionals.length > 0) {
    throw new ReviewError(
      `ship-it-review-list.mjs takes no arguments.\n\n${USAGE}`,
    );
  }

  const repository = resolveRepository(flags.repo);
  const labels = ghList(`repos/${repository}/labels?per_page=100`);

  const reviewLabels = labels
    .map(({ name, description }) => ({
      label: name,
      ...parseReviewLabel(name),
      focus: parseFocus(description),
    }))
    .filter((label) => label.service && label.focus)
    .map(({ label, service, kind, focus }) => ({ label, service, kind, focus }))
    .sort(
      (a, b) =>
        FOCUS_ORDER.indexOf(a.focus) - FOCUS_ORDER.indexOf(b.focus) ||
        a.label.localeCompare(b.label),
    );

  printJson(reviewLabels);
});
