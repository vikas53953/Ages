/**
 * PDF and Word (.docx) → text, for the read tool, @file in the terminal and files attached in Studio. Aegis pulls
 * the text out and gives the model plain text, so every model and the secret filter see the same thing. PDFs go
 * through pdf.js (via unpdf); a .docx is a zip of XML, unpacked with Node's own zlib (no package). A scanned PDF
 * (pictures of pages, no text layer) gives a clear note instead.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createInflateRaw } from "node:zlib";
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
 * The heap cap does not cover decoded streams (ArrayBuffers): a 1 MB PDF can inflate to gigabytes. So the
 * process's buffer and total memory are watched while the worker runs, and it is killed past these.
 */
const PDF_MAX_BUFFER_GROWTH = 512 * 1024 * 1024;
const PDF_MAX_RSS_GROWTH = 1024 * 1024 * 1024;
const PDF_MEMORY_CHECK_MS = 25;
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
        const start = process.memoryUsage();
        const watch = setInterval(() => {
            const now = process.memoryUsage();
            if (now.arrayBuffers - start.arrayBuffers > PDF_MAX_BUFFER_GROWTH || now.rss - start.rss > PDF_MAX_RSS_GROWTH) {
                finish(() => reject(new Error(`${name} needs too much memory to read`)));
            }
        }, PDF_MEMORY_CHECK_MS);
        const finish = (done) => {
            if (settled)
                return;
            settled = true;
            clearInterval(watch);
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
/** Word files: bigger ones are refused before unpacking. */
export const MAX_DOCX_BYTES = 10 * 1024 * 1024;
/**
 * A .docx is a zip; one part unpacked may not grow past this. A small file built to unpack to gigabytes (a "zip
 * bomb") is stopped here, before the memory is taken.
 */
const DOCX_MAX_UNPACKED = 50 * 1024 * 1024;
/** Text kept from one Word file, like one PDF. */
const MAX_DOCX_TEXT_CHARS = MAX_PDF_TEXT_CHARS;
export function isDocxPath(file) {
    return /\.docx$/i.test(file);
}
/** A .docx starts like every zip: "PK", 3, 4. */
export function looksLikeZip(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
/** Word saves a password-protected .docx (and an old .doc) as an OLE file, not a zip. */
function looksLikeOle(bytes) {
    const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return bytes.length >= 8 && magic.every((byte, index) => bytes[index] === byte);
}
/**
 * Unpacks one zip part as a stream, off the main thread in pieces, and stops the moment it passes `cap` bytes (a bomb
 * never gets to fill memory). A stream, not zlib's one-shot call: that one froze Aegis for ~0.5 s on a 50 MB part.
 */
function inflateCapped(data, cap) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const stream = createInflateRaw({ chunkSize: 256 * 1024 });
        stream.on("data", (chunk) => {
            size += chunk.length;
            if (size > cap) {
                stream.destroy();
                reject(Object.assign(new Error("too large"), { code: "ERR_BUFFER_TOO_LARGE" }));
                return;
            }
            chunks.push(chunk);
        });
        stream.on("end", () => resolve(Buffer.concat(chunks, size)));
        stream.on("error", reject);
        stream.end(data);
    });
}
/** The zip's table of contents (its central directory). Only what a .docx needs: no zip64, no multi-disk. */
function zipEntries(buf, name) {
    const broken = (why) => new Error(`${name} could not be read as a Word file (${why})`);
    // The end record is in the last 22 bytes, or up to 64 KB earlier when the zip has a comment.
    let end = -1;
    for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 0xffff); at--) {
        if (buf.readUInt32LE(at) === 0x06054b50) {
            end = at;
            break;
        }
    }
    if (end < 0)
        throw broken("no zip directory");
    const count = buf.readUInt16LE(end + 10);
    const size = buf.readUInt32LE(end + 12);
    let at = buf.readUInt32LE(end + 16);
    if (count === 0xffff || size === 0xffffffff || at === 0xffffffff)
        throw broken("zip64 is not supported");
    if (at + size > end)
        throw broken("bad zip directory");
    const entries = [];
    for (let index = 0; index < count; index++) {
        if (at + 46 > end || buf.readUInt32LE(at) !== 0x02014b50)
            throw broken("bad zip directory");
        const nameLength = buf.readUInt16LE(at + 28);
        const skip = nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
        entries.push({
            name: buf.toString("utf8", at + 46, at + 46 + nameLength),
            flags: buf.readUInt16LE(at + 8),
            method: buf.readUInt16LE(at + 10),
            packed: buf.readUInt32LE(at + 20),
            size: buf.readUInt32LE(at + 24),
            local: buf.readUInt32LE(at + 42),
        });
        at += 46 + skip;
    }
    return entries;
}
/** One file out of the zip, unpacked, never past DOCX_MAX_UNPACKED. */
async function zipRead(buf, entry, name) {
    const broken = (why) => new Error(`${name} could not be read as a Word file (${why})`);
    const tooBig = () => new Error(`${name} needs too much memory to read (its text unpacks to over ${DOCX_MAX_UNPACKED / 1024 / 1024} MB)`);
    if (entry.flags & 1)
        throw new Error(`${name} is password-protected`);
    if (entry.size > DOCX_MAX_UNPACKED)
        throw tooBig();
    const at = entry.local;
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50)
        throw broken("bad zip entry");
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    if (start + entry.packed > buf.length)
        throw broken("the file is cut short");
    const data = buf.subarray(start, start + entry.packed);
    if (entry.method === 0)
        return data;
    if (entry.method !== 8)
        throw broken(`zip method ${entry.method} is not supported`);
    try {
        return await inflateCapped(data, DOCX_MAX_UNPACKED);
    }
    catch (error) {
        if (error.code === "ERR_BUFFER_TOO_LARGE")
            throw tooBig();
        throw broken("damaged zip data");
    }
}
const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function xmlDecode(text) {
    return text.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|\w{1,10});/gi, (whole, code) => {
        if (code[0] !== "#")
            return XML_ENTITIES[code] ?? whole;
        const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        // NUL, lone surrogate halves and out-of-range numbers are not characters: a replacement mark instead.
        return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : "�";
    });
}
/** Parts whose text is not what Word shows: a text box's old-Word copy, and the old place of moved text. */
const SKIPPED = new Set(["mc:Fallback", "w:moveFrom"]);
const TAG_NAME = /(\/?)([\w.:-]+)/y;
/**
 * The text of word/document.xml: paragraphs as lines, tabs and line breaks kept, a table as "| a | b |" rows.
 * Deleted text (tracked changes) is left out, inserted text is kept (what Word shows once changes are accepted).
 * A text box's copy for old Word versions (mc:Fallback) and moved text's old place (w:moveFrom) are skipped, so
 * nothing is doubled; tab-stop settings (in w:pPr) are not tabs. Only the "w:" prefix is read (Word, LibreOffice
 * and Google Docs all write it).
 *
 * A plain left-to-right scan with indexOf, no backtracking regex: every byte is looked at a bounded number of
 * times, so a file built to be slow cannot freeze Aegis, and the text stops at `limit` (cells included).
 */
async function documentXmlText(xml, limit, signal, stopped) {
    let out = "";
    let used = 0;
    const cells = [];
    const rows = [];
    let inText = false;
    let skipped = 0;
    let settings = 0;
    const write = (text) => {
        if (used >= limit)
            return;
        const kept = text.length > limit - used ? text.slice(0, limit - used) : text;
        used += kept.length;
        if (cells.length)
            cells[cells.length - 1] += kept;
        else
            out += kept;
    };
    // An entity is at most 12 characters (&#x + 8 digits + ;) and gives at least one, so this much raw text is enough
    // for what is left: text past it can only be text past the cap.
    const room = () => (limit - used) * 12 + 16;
    let steps = 0;
    let pos = 0;
    while (pos < xml.length && used < limit) {
        // Up to 50 MB of XML: let the terminal and Studio breathe now and then, and let Stop end it.
        if (++steps % 20_000 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
            if (signal?.aborted)
                throw stopped();
        }
        const lt = xml.indexOf("<", pos);
        const end = lt < 0 ? xml.length : lt;
        if (end > pos) {
            if (inText && !skipped && !settings)
                write(xmlDecode(xml.slice(pos, Math.min(end, pos + room()))));
            pos = end;
            continue;
        }
        if (xml.startsWith("<!--", lt)) {
            const close = xml.indexOf("-->", lt + 4);
            if (close < 0)
                break;
            pos = close + 3;
            continue;
        }
        if (xml.startsWith("<![CDATA[", lt)) {
            const close = xml.indexOf("]]>", lt + 9);
            if (close < 0)
                break;
            if (inText && !skipped && !settings)
                write(xml.slice(lt + 9, Math.min(close, lt + 9 + room())));
            pos = close + 3;
            continue;
        }
        const gt = xml.indexOf(">", lt + 1);
        if (gt < 0)
            break;
        pos = gt + 1;
        TAG_NAME.lastIndex = lt + 1;
        const match = TAG_NAME.exec(xml);
        if (!match || match.index + match[0].length > gt)
            continue;
        const closing = match[1] === "/";
        const tag = match[2];
        const selfClosing = !closing && xml[gt - 1] === "/";
        const opens = !closing && !selfClosing;
        if (SKIPPED.has(tag)) {
            if (!selfClosing)
                skipped = Math.max(0, skipped + (closing ? -1 : 1));
        }
        else if (skipped) {
            continue;
        }
        else if (tag === "w:pPr") {
            if (!selfClosing)
                settings = Math.max(0, settings + (closing ? -1 : 1));
        }
        else if (settings) {
            continue;
        }
        else if (tag === "w:t") {
            inText = opens;
        }
        else if (tag === "w:tab" && selfClosing) {
            write("\t");
        }
        else if ((tag === "w:br" || tag === "w:cr") && selfClosing) {
            write(cells.length ? " " : "\n");
        }
        else if (tag === "w:noBreakHyphen" && selfClosing) {
            write("-");
        }
        else if (tag === "w:p" && !opens) {
            write(cells.length ? " " : "\n");
        }
        else if (tag === "w:tr" && !selfClosing) {
            if (opens)
                rows.push([]);
            else {
                const row = rows.pop() ?? [];
                // The cells' text was counted when it was written; the row counts it again, so it is taken off first.
                used -= row.reduce((sum, cell) => sum + cell.length, 0);
                write(`| ${row.join(" | ")} |${cells.length ? " " : "\n"}`);
            }
        }
        else if (tag === "w:tc" && !selfClosing) {
            if (opens)
                cells.push("");
            else {
                const raw = cells.pop() ?? "";
                const cell = raw.replace(/\s+/g, " ").trim();
                used -= raw.length - cell.length;
                rows[rows.length - 1]?.push(cell);
            }
        }
    }
    const cut = used >= limit;
    // Cut off (or never closed) inside a table: its cells so far are still text, and already counted.
    const open = [...rows.flat(), ...cells].map((cell) => cell.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (open.length)
        out += `| ${open.join(" | ")} |`;
    const text = out
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return { text, cut };
}
/**
 * A Word (.docx) file's text: the main body with its tables. Headers, footers, footnotes, comments and pictures are
 * left out. Throws a plain-words error for anything it cannot read. `signal` (Stop) ends it.
 */
export async function docxText(bytes, name = "the Word file", options = {}) {
    const { signal } = options;
    const stopped = () => new Error(`reading ${name} was stopped`);
    if (bytes.length > MAX_DOCX_BYTES)
        throw new Error(`${name} is over ${MAX_DOCX_BYTES / 1024 / 1024} MB`);
    if (looksLikeOle(bytes)) {
        throw new Error(`${name} is password-protected, or is an old Word file (.doc). Remove the password, or save it as .docx in Word, and attach it again`);
    }
    if (!looksLikeZip(bytes))
        throw new Error(`${name} is not a Word (.docx) file`);
    if (signal?.aborted)
        throw stopped();
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = zipEntries(buf, name);
    let main = entries.find((entry) => entry.name === "word/document.xml");
    if (!main) {
        // Some tools name the body differently; the package's own index says which part it is.
        const rels = entries.find((entry) => entry.name === "_rels/.rels");
        const xml = rels ? (await zipRead(buf, rels, name)).toString("utf8") : "";
        const target = /<Relationship\b[^>]*Type="[^"]*\/officeDocument"[^>]*>/.exec(xml)?.[0].match(/Target="\/?([^"]+)"/)?.[1];
        main = target ? entries.find((entry) => entry.name === target) : undefined;
    }
    if (!main)
        throw new Error(`${name} is not a Word (.docx) file (it has no document inside)`);
    const xml = (await zipRead(buf, main, name)).toString("utf8");
    if (signal?.aborted)
        throw stopped();
    const { text, cut } = await documentXmlText(xml, MAX_DOCX_TEXT_CHARS, signal, stopped);
    if (!text)
        return "[Word document: no text found. It may hold only pictures, which Aegis cannot read yet.]";
    const note = cut ? `\n\n[cut: text from one Word file is limited to ${MAX_DOCX_TEXT_CHARS.toLocaleString("en-US")} characters]` : "";
    return `[Word document; body text and tables only, pictures, headers and footers are left out]\n\n${text}${note}`;
}
