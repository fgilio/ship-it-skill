interface InvoiceLine {
  title: string;
  quantity: number;
  unitPriceInCents: number;
}

export interface Invoice {
  id: string;
  customer: string;
  issuedOn: string;
  lines: InvoiceLine[];
}

export type DownloadFormat = "text" | "csv";

export const DOWNLOAD_FORMATS: readonly DownloadFormat[] = ["text", "csv"];

export const INVOICES: readonly Invoice[] = [
  {
    id: "INV-1001",
    customer: "Northwind Library",
    issuedOn: "2026-10-03",
    lines: [
      {
        title: "The Quiet Harbor (ebook)",
        quantity: 12,
        unitPriceInCents: 899,
      },
      {
        title: "Maps of Rain (audiobook)",
        quantity: 3,
        unitPriceInCents: 1499,
      },
    ],
  },
  {
    id: "INV-1002",
    customer: "Riverside School",
    issuedOn: "2026-10-17",
    lines: [
      { title: "Field Notes (ebook)", quantity: 40, unitPriceInCents: 499 },
    ],
  },
];

export function findInvoice(id: string): Invoice | undefined {
  return INVOICES.find((invoice) => invoice.id === id);
}

export function invoiceTotalInCents(invoice: Invoice): number {
  return invoice.lines.reduce(
    (total, line) => total + line.quantity * line.unitPriceInCents,
    0,
  );
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function isDownloadFormat(value: string): value is DownloadFormat {
  return DOWNLOAD_FORMATS.some((format) => format === value);
}

export function renderInvoice(
  invoice: Invoice,
  format: DownloadFormat,
): string {
  if (format === "csv") {
    return [
      "title,quantity,unit_price_cents",
      ...invoice.lines.map(
        (line) => `"${line.title}",${line.quantity},${line.unitPriceInCents}`,
      ),
    ].join("\n");
  }

  return [
    `Invoice ${invoice.id} for ${invoice.customer}, issued ${invoice.issuedOn}`,
    ...invoice.lines.map(
      (line) =>
        `  ${line.quantity} x ${line.title} at ${formatCents(line.unitPriceInCents)}`,
    ),
    `Total: ${formatCents(invoiceTotalInCents(invoice))}`,
  ].join("\n");
}
