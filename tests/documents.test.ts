import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { looksLikePdf, MAX_PDF_BYTES, MAX_PDF_PAGES, pdfText } from "../src/documents.ts";
import { readPath } from "../src/tools/read.ts";
import { makeInflatingPdf, makePdf, makeSlowPdf } from "./fixtures/pdf.ts";

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

  it("a PDF built to be slow is read in its own thread: Aegis stays responsive, and the time limit or Stop ends it", async () => {
    const slow = makeSlowPdf();
    let ticks = 0;
    const clock = setInterval(() => ticks++, 20);
    const started = Date.now();
    await expect(pdfText(slow, "slow.pdf", { timeoutMs: 1500 })).rejects.toThrow("slow.pdf took too long to read");
    clearInterval(clock);
    expect(Date.now() - started).toBeLessThan(5000);
    // About 75 ticks in 1.5 s when nothing blocks; a parse on this thread would have starved the clock.
    expect(ticks).toBeGreaterThan(30);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    await expect(pdfText(slow, "slow.pdf", { signal: stop.signal })).rejects.toThrow("reading slow.pdf was stopped");
  });

  it("a small PDF that inflates to hundreds of MB is stopped for memory, not left to take the PC down", async () => {
    const bomb = await makeInflatingPdf();
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const before = process.memoryUsage().rss;
    await expect(pdfText(bomb, "bomb.pdf")).rejects.toThrow(/bomb.pdf (needs too much memory to read|took too long to read)/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(process.memoryUsage().rss - before).toBeLessThan(1.5 * 1024 * 1024 * 1024);
  }, 60_000);
});
