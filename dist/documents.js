/**
 * PDF → text, for the read tool, @file.pdf in the terminal and PDFs attached in Studio. Aegis pulls the text
 * layer out with pdf.js (via unpdf, no other packages) and gives the model plain text, so every model and the
 * secret filter see the same thing. A scanned PDF (pictures of pages, no text layer) gives a clear note instead.
 */
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
/** The PDF's text, page by page, with a header line; throws a plain-words error for anything it cannot read. */
export async function pdfText(bytes, name = "the PDF") {
    if (bytes.length > MAX_PDF_BYTES)
        throw new Error(`${name} is over ${MAX_PDF_BYTES / 1024 / 1024} MB`);
    if (!looksLikePdf(bytes))
        throw new Error(`${name} is not a PDF file`);
    const { getDocumentProxy } = await import("unpdf");
    let doc;
    let timer;
    const work = (async () => {
        // A copy: pdf.js takes ownership of the buffer it is given.
        doc = await getDocumentProxy(new Uint8Array(bytes), {
            // Text only: no fonts loaded, no system fonts, no scripted forms (pdf.js no longer runs eval at all).
            disableFontFace: true,
            enableXfa: false,
            useSystemFonts: false,
            stopAtErrors: false,
            // Errors only: pdf.js warnings (missing fonts and the like) would print over the terminal UI.
            verbosity: 0,
        });
        const total = doc.numPages;
        const count = Math.min(total, MAX_PDF_PAGES);
        const pages = [];
        for (let number = 1; number <= count; number++) {
            const page = await doc.getPage(number);
            const content = await page.getTextContent();
            let line = "";
            for (const item of content.items) {
                if (typeof item.str !== "string")
                    continue;
                line += item.str + (item.hasEOL ? "\n" : "");
            }
            pages.push(line.replace(/[ \t]+\n/g, "\n").trim());
            page.cleanup();
        }
        return { total, pages };
    })();
    const tooSlow = new Error(`${name} took too long to read`);
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(tooSlow), PDF_TIMEOUT_MS);
    });
    try {
        const { total, pages } = await Promise.race([work, timeout]);
        const withText = pages.filter((page) => page.length > 0).length;
        if (!withText) {
            return `[PDF, ${total} page${total === 1 ? "" : "s"}: no text found. It is probably scanned pages (pictures), which Aegis cannot read yet.]`;
        }
        const shown = pages.length < total ? `pages 1-${pages.length} of ${total} (the rest are not read)` : `${total} page${total === 1 ? "" : "s"}`;
        const body = pages.map((page, index) => `--- page ${index + 1} ---\n${page || "[no text on this page]"}`).join("\n\n");
        return `[PDF, ${shown}; text only, pictures are left out]\n\n${body}`;
    }
    catch (error) {
        if (error === tooSlow)
            throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (/password/i.test(message) || error?.name === "PasswordException")
            throw new Error(`${name} is password-protected`);
        throw new Error(`${name} could not be read as a PDF (${message.slice(0, 200)})`);
    }
    finally {
        clearTimeout(timer);
        // A timed-out read may still finish later: swallow its result and free what pdf.js holds.
        void work.catch(() => undefined);
        await doc?.cleanup().catch(() => undefined);
    }
}
