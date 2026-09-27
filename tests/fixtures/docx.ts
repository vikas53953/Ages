import { crc32, deflateRawSync } from "node:zlib";

type Part = { name: string; data: Buffer | string; store?: boolean; encrypted?: boolean };

/** A zip holding these parts (deflated unless `store`), with real CRCs, as Word writes one. */
export function makeZip(parts: Part[]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const raw = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, "utf8");
    const packed = part.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(part.name, "utf8");
    const flags = part.encrypted ? 1 : 0;
    const method = part.store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** word/document.xml around this body XML. */
export function documentXml(body: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

/** A paragraph of one run. */
export const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** A table: rows of cells, each cell one paragraph. */
export const table = (rows: string[][]) =>
  `<w:tbl>${rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${para(cell)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;

/** A minimal .docx (what Word needs to open it) with this body XML, plus a header part that must not be read. */
export function makeDocx(body: string, extra: Part[] = []) {
  return makeZip([
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: "_rels/.rels",
      data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    { name: "word/document.xml", data: documentXml(body) },
    { name: "word/header1.xml", data: `<w:hdr ${W}>${para("HEADER TEXT")}</w:hdr>` },
    ...extra,
  ]);
}

/** A small .docx whose body unpacks to `mb` megabytes (a zip bomb). */
export function makeDocxBomb(mb = 200) {
  return makeZip([{ name: "word/document.xml", data: Buffer.alloc(mb * 1024 * 1024, 0x20) }]);
}
