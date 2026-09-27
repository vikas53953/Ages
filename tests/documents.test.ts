import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { looksLikePdf, MAX_PDF_BYTES, MAX_PDF_PAGES, pdfText } from "../src/documents.ts";
import { readPath } from "../src/tools/read.ts";
import { makePdf } from "./fixtures/pdf.ts";

describe("PDF text", () => {
  it("gives the text page by page with a header", async () => {
    const text = await pdfText(makePdf(["config firewall policy", "edit 12"]), "fw.pdf");
    expect(text).toContain("[PDF, 2 pages; text only");
    expect(text).toMatch(/--- page 1 ---\nconfig firewall policy/);
    expect(text).toMatch(/--- page 2 ---\nedit 12/);
  });

  it("says so when there is no text (scanned pages)", async () => {
    expect(await pdfText(makePdf(["", ""]), "scan.pdf")).toMatch(/no text found.*scanned/);
  });

  it("refuses what is not a PDF, a broken PDF and a too-big one, in plain words", async () => {
    expect(looksLikePdf(Buffer.from("hello"))).toBe(false);
    await expect(pdfText(Buffer.from("hello"), "x.pdf")).rejects.toThrow("x.pdf is not a PDF file");
    await expect(pdfText(Buffer.from("%PDF-1.4 junk junk"), "b.pdf")).rejects.toThrow(/b.pdf could not be read as a PDF/);
    await expect(pdfText(Buffer.alloc(MAX_PDF_BYTES + 1), "big.pdf")).rejects.toThrow("big.pdf is over 10 MB");
  });

  it(`reads at most ${MAX_PDF_PAGES} pages and says how many there are`, async () => {
    const pages = Array.from({ length: MAX_PDF_PAGES + 2 }, (_, i) => `page text ${i + 1}`);
    const text = await pdfText(makePdf(pages), "long.pdf");
    expect(text).toContain(`pages 1-${MAX_PDF_PAGES} of ${MAX_PDF_PAGES + 2}`);
    expect(text).toContain(`page text ${MAX_PDF_PAGES}`);
    expect(text).not.toContain(`page text ${MAX_PDF_PAGES + 1}`);
  });

  it("the read tool reads a .pdf as text, and offset/limit work on that text", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-pdf-"));
    await writeFile(path.join(cwd, "report.pdf"), makePdf(["alpha line", "beta line"]));
    expect(await readPath("report.pdf", cwd)).toContain("alpha line");
    const slice = await readPath("report.pdf", cwd, { offset: 5, limit: 2 });
    expect(slice).toMatch(/--- page 2 ---/);
    expect(slice).toContain("[lines 5-6 of");
    await writeFile(path.join(cwd, "fake.pdf"), "just text");
    await expect(readPath("fake.pdf", cwd)).rejects.toThrow("fake.pdf is not a PDF file");
  });
});
