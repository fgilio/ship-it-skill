import { describe, expect, test } from "bun:test";

import {
  findInvoice,
  invoiceTotalInCents,
  isDownloadFormat,
  renderInvoice,
} from "../src/invoices";

describe("invoices", () => {
  test("adds up every line of an invoice", () => {
    const invoice = findInvoice("INV-1001");

    expect(invoice).toBeDefined();
    expect(invoice && invoiceTotalInCents(invoice)).toBe(15_285);
  });

  test("renders an invoice as text and as csv", () => {
    const invoice = findInvoice("INV-1002");

    expect(invoice && renderInvoice(invoice, "text")).toContain(
      "Total: $199.60",
    );
    expect(invoice && renderInvoice(invoice, "csv")).toBe(
      'title,quantity,unit_price_cents\n"Field Notes (ebook)",40,499',
    );
  });

  test("knows the formats it can download", () => {
    expect(isDownloadFormat("csv")).toBe(true);
    expect(isDownloadFormat("pdf")).toBe(false);
  });
});
