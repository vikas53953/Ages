import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docxText, MAX_DOCX_BYTES } from "../src/documents.ts";
import { readPath } from "../src/tools/read.ts";
import { documentXml, makeDocx, makeDocxBomb, makeZip, para, table } from "./fixtures/docx.ts";

describe("Word (.docx) text", () => {
  it("gives paragraphs as lines and tables as rows, with a header; the page header part is not read", async () => {
    const body =
      para("Change request CR-1042") +
      '<w:p><w:r><w:t>Owner:</w:t></w:r><w:r><w:tab/><w:t>Vikas</w:t></w:r><w:r><w:br/><w:t>Window: Sat 02:00</w:t></w:r></w:p>' +
      table([
        ["Rule", "Action"],
        ["12", "deny &amp; log"],
      ]) +
      para("Tom &lt;3 &#x2713; &#8364;");
    const text = await docxText(makeDocx(body), "cr.docx");
    expect(text).toMatch(/^\[Word document; body text and tables only/);
    expect(text).toContain("Change request CR-1042\nOwner:\tVikas\nWindow: Sat 02:00");
    expect(text).toContain("| Rule | Action |\n| 12 | deny & log |");
    expect(text).toContain("Tom <3 ✓ €");
    expect(text).not.toContain("HEADER TEXT");
  });

  it("keeps inserted text, leaves out deleted text, and does not double a text box's fallback copy", async () => {
    const body =
      '<w:p><w:ins><w:r><w:t>added </w:t></w:r></w:ins><w:del><w:r><w:delText>REMOVED</w:delText></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>' +
      '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>' +
      para("in the box") +
      "</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>" +
      para("in the box") +
      "</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>";
    const text = await docxText(makeDocx(body), "t.docx");
    expect(text).toContain("added kept");
    expect(text).not.toContain("REMOVED");
    expect(text.match(/in the box/g)).toHaveLength(1);
  });

  it("finds the body through the package index when it is not word/document.xml", async () => {
    const zip = makeZip([
      {
        name: "_rels/.rels",
        data: '<Relationships><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document2.xml"/></Relationships>',
      },
      { name: "word/document2.xml", data: documentXml(para("from part two")), store: true },
    ]);
    expect(await docxText(zip, "odd.docx")).toContain("from part two");
  });

  it("says so when there is no text", async () => {
    expect(await docxText(makeDocx("<w:p/>"), "empty.docx")).toMatch(/no text found/);
  });

  it("refuses what is not a .docx, an old .doc or locked one, a broken one and a too-big one, in plain words", async () => {
    await expect(docxText(Buffer.from("hello"), "a.docx")).rejects.toThrow("a.docx is not a Word (.docx) file");
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    await expect(docxText(ole, "locked.docx")).rejects.toThrow(/locked.docx is password-protected, or is an old Word file/);
    await expect(docxText(makeZip([{ name: "x.txt", data: "x" }]), "zip.docx")).rejects.toThrow(/has no document inside/);
    await expect(docxText(Buffer.from("PK\u0003\u0004junk"), "junk.docx")).rejects.toThrow(/could not be read as a Word file/);
    const cut = makeDocx(para("hello"));
    await expect(docxText(cut.subarray(0, cut.length - 30), "cut.docx")).rejects.toThrow(/could not be read as a Word file/);
    const locked = makeZip([{ name: "word/document.xml", data: "x", store: true, encrypted: true }]);
    await expect(docxText(locked, "zc.docx")).rejects.toThrow("zc.docx is password-protected");
    await expect(docxText(Buffer.alloc(MAX_DOCX_BYTES + 1), "big.docx")).rejects.toThrow("big.docx is over 10 MB");
  });

  it("a small .docx that unpacks to hundreds of MB (a zip bomb) is stopped at 50 MB, not unpacked", async () => {
    const bomb = makeDocxBomb(200);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const before = process.memoryUsage().rss;
    await expect(docxText(bomb, "bomb.docx")).rejects.toThrow(/bomb.docx needs too much memory to read/);
    expect(process.memoryUsage().rss - before).toBeLessThan(300 * 1024 * 1024);
  });

  it("a zip that lies about its size is still stopped at 50 MB", async () => {
    const bomb = makeDocxBomb(200);
    // Patch both the local and central "unpacked size" fields to say 1 KB.
    bomb.writeUInt32LE(1024, 22);
    const central = bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(1024, central + 24);
    await expect(docxText(bomb, "liar.docx")).rejects.toThrow(/needs too much memory to read/);
  });

  it("Stop ends a read", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(docxText(makeDocx(para("x")), "s.docx", { signal: stop.signal })).rejects.toThrow("reading s.docx was stopped");
  });

  it("the read tool reads a .docx as text, and offset/limit work on that text", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-docx-"));
    await writeFile(path.join(cwd, "plan.docx"), makeDocx(["one", "two", "three"].map(para).join("")));
    await writeFile(path.join(cwd, "fake.docx"), "just text");
    const whole = await readPath("plan.docx", cwd);
    expect(whole).toContain("one\ntwo\nthree");
    expect(await readPath("plan.docx", cwd, { offset: 4, limit: 1 })).toMatch(/^4 {2}two\n\[lines 4-4 of 5\]$/);
    await expect(readPath("fake.docx", cwd)).rejects.toThrow("fake.docx is not a Word (.docx) file");
  });
});
