/**
 * PDF → text, for the read tool, @file.pdf in the terminal and PDFs attached in Studio. Aegis pulls the text
 * layer out with pdf.js (via unpdf, no other packages) and gives the model plain text, so every model and the
 * secret filter see the same thing. A scanned PDF (pictures of pages, no text layer) gives a clear note instead.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
/** Bigger PDFs are refused before parsing. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** Pages read from one PDF; the rest are counted, not read. */
export const MAX_PDF_PAGES = 100;
/** A PDF that takes longer than this to read is given up on. */
const PDF_TIMEOUT_MS = 30_000;
export function isPdfPath(file) {
    return /\.pdf$/i.test(file);
}
/** A PDF starts with "%PDF-" (a few junk bytes before it are allowed, as readers allow). */
export function looksLikePdf(bytes) {
    const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
    return head.includes("%PDF-");
}
/** Text kept from one PDF, all pages together (the prompt cuts it further; this bounds the work). */
const MAX_PDF_TEXT_CHARS = 1_000_000;
/** Memory the PDF reader may use; a PDF built to blow up is stopped, not Aegis. */
const PDF_WORKER_HEAP_MB = 256;
/**
 * Runs in its own thread (a worker), so a PDF built to be slow cannot freeze the terminal or Studio, and a
 * timeout or Stop really ends it (the thread is killed). Given as source, not a file; written to run as either
 * a script or a module (Node picks by how Aegis was started), so it only uses import().
 */
const WORKER_SOURCE = `
(async () => {
  const { parentPort, workerData } = await import("node:worker_threads");
  try {
    const { getDocumentProxy } = await import(workerData.unpdf);
    const doc = await getDocumentProxy(new Uint8Array(workerData.bytes), {
      disableFontFace: true,
      enableXfa: false,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    const total = doc.numPages;
    const count = Math.min(total, workerData.maxPages);
    const pages = [];
    let room = workerData.maxChars;
    for (let number = 1; number <= count && room > 0; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      let line = "";
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        line += item.str + (item.hasEOL ? "\\n" : "");
        if (line.length > room) break;
      }
      line = line.replace(/[ \\t]+\\n/g, "\\n").trim().slice(0, room);
      room -= line.length;
      pages.push(line);
      page.cleanup();
    }
    parentPort.postMessage({ total, pages, cut: room <= 0 });
  } catch (error) {
    parentPort.postMessage({ error: String((error && error.message) || error), name: error && error.name });
  }
})();
`;
/** Where the unpdf package is, as a file URL the worker can import (works from src/ under tsx and from dist/). */
function unpdfUrl() {
    return pathToFileURL(createRequire(import.meta.url).resolve("unpdf")).href;
}
/**
 * The PDF's text, page by page, with a header line; throws a plain-words error for anything it cannot read.
 * `signal` (Stop, or the end of a turn) ends the read at once.
 */
export async function pdfText(bytes, name = "the PDF", options = {}) {
    const { signal, timeoutMs = PDF_TIMEOUT_MS } = options;
    if (bytes.length > MAX_PDF_BYTES)
        throw new Error(`${name} is over ${MAX_PDF_BYTES / 1024 / 1024} MB`);
    if (!looksLikePdf(bytes))
        throw new Error(`${name} is not a PDF file`);
    if (signal?.aborted)
        throw new Error(`reading ${name} was stopped`);
    const reply = await new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_SOURCE, {
            eval: true,
            // A copy the worker owns; the caller's buffer is left alone.
            workerData: { bytes: new Uint8Array(bytes), unpdf: unpdfUrl(), maxPages: MAX_PDF_PAGES, maxChars: MAX_PDF_TEXT_CHARS },
            resourceLimits: { maxOldGenerationSizeMb: PDF_WORKER_HEAP_MB },
            // Its output is not ours to print: nothing from pdf.js may land on the terminal UI.
            stdout: true,
            stderr: true,
        });
        let settled = false;
        const finish = (done) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            void worker.terminate();
            done();
        };
        const timer = setTimeout(() => finish(() => reject(new Error(`${name} took too long to read (over ${Math.round(timeoutMs / 1000)} s)`))), timeoutMs);
        const onAbort = () => finish(() => reject(new Error(`reading ${name} was stopped`)));
        signal?.addEventListener("abort", onAbort, { once: true });
        worker.stdout.resume();
        worker.stderr.resume();
        worker.once("message", (message) => finish(() => resolve(message)));
        worker.once("error", (error) => finish(() => reject(new Error(/memory|heap/i.test(error.message) ? `${name} needs too much memory to read` : error.message))));
        worker.once("exit", () => finish(() => reject(new Error(`${name} could not be read as a PDF`))));
    });
    if ("error" in reply) {
        if (/password/i.test(reply.error) || reply.name === "PasswordException")
            throw new Error(`${name} is password-protected`);
        throw new Error(`${name} could not be read as a PDF (${reply.error.slice(0, 200)})`);
    }
    const { total, pages, cut } = reply;
    if (!pages.some((page) => page.length > 0)) {
        return `[PDF, ${total} page${total === 1 ? "" : "s"}: no text found. It is probably scanned pages (pictures), which Aegis cannot read yet.]`;
    }
    const shown = pages.length < total ? `pages 1-${pages.length} of ${total} (the rest are not read)` : `${total} page${total === 1 ? "" : "s"}`;
    const body = pages.map((page, index) => `--- page ${index + 1} ---\n${page || "[no text on this page]"}`).join("\n\n");
    const note = cut ? `\n\n[cut: text from one PDF is limited to ${MAX_PDF_TEXT_CHARS.toLocaleString("en-US")} characters]` : "";
    return `[PDF, ${shown}; text only, pictures are left out]\n\n${body}${note}`;
}
