import {
  DOWNLOAD_FORMATS,
  findInvoice,
  formatCents,
  INVOICES,
  invoiceTotalInCents,
  isDownloadFormat,
  renderInvoice,
} from "./invoices";

const [command, id, ...options] = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (command === "list") {
  for (const invoice of INVOICES) {
    console.log(
      `${invoice.id}  ${invoice.customer}  ${formatCents(invoiceTotalInCents(invoice))}`,
    );
  }
} else if (command === "download") {
  const invoice =
    findInvoice(id ?? "") ?? fail(`Unable to find invoice: ${id}`);
  const formatIndex = options.indexOf("--format");
  const requested =
    formatIndex === -1 ? "text" : (options[formatIndex + 1] ?? "");

  if (!isDownloadFormat(requested)) {
    fail(
      `The format must be one of ${DOWNLOAD_FORMATS.join(", ")}, got "${requested}".`,
    );
  }

  console.log(renderInvoice(invoice, requested));
} else {
  fail(
    "Usage: bun src/cli.ts list | download <invoice id> [--format text|csv]",
  );
}
