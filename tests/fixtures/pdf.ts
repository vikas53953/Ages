/** A small valid PDF with one line of text per page ("" = a page with no text, like a scanned page). */
export function makePdf(pages: string[]) {
  const objs: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((text, i) => {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text.replace(/([\\()])/g, "\\$1")}) Tj ET` : "";
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A small PDF that is slow to read: many pages share one compressed stream holding megabytes of text. */
export function makeSlowPdf(pageCount = 100, streamMb = 5) {
  const { deflateSync } = process.getBuiltinModule("node:zlib") as typeof import("node:zlib");
  const line = "BT /F1 1 Tf 0 0 Td (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) Tj ET\n";
  const raw = Buffer.from(line.repeat(Math.ceil((streamMb * 1024 * 1024) / line.length)), "latin1");
  const packed = deflateSync(raw);
  const objs: Buffer[] = [];
  const kids = Array.from({ length: pageCount }, (_, i) => `${5 + i} 0 R`).join(" ");
  objs.push(Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
  objs.push(Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`, "latin1"));
  objs.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "latin1"));
  objs.push(Buffer.concat([Buffer.from(`<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), packed, Buffer.from("\nendstream", "latin1")]));
  for (let i = 0; i < pageCount; i++) {
    objs.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>`, "latin1"));
  }
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let size = parts[0]!.length;
  const offsets: number[] = [];
  objs.forEach((obj, i) => {
    offsets.push(size);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), obj, Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk);
    size += chunk.length;
  });
  const tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  parts.push(Buffer.from(tail, "latin1"));
  return Buffer.concat(parts);
}
