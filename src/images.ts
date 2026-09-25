/**
 * Images in a prompt ("why does @shots/error.png say this?", or a pasted path): read through the lock like any
 * file, recognised by their first bytes (never the extension), capped, and sent to the model only in the turn
 * they are attached. Saved history keeps a one-line note instead of the bytes, so sessions stay small and a
 * later rule change is respected the next time the image is attached.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { inferEntry, normalizeModelId } from "./catalog.ts";
import { assertInsideCwd } from "./env.ts";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type ImageAttachment = { path: string; mediaType: ImageMediaType; bytes: number; data: string };

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_TURN = 4;
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp)$/i;

/** Only a hint for which path to take: the first bytes decide. */
export function isImagePath(file: string) {
  return IMAGE_EXTENSIONS.test(file);
}

/** The image type from its first bytes, or undefined (an SVG, a text file named .png, anything else). */
export function sniffImage(buf: Uint8Array): ImageMediaType | undefined {
  const at = (i: number) => buf[i];
  if (buf.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (buf.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const ascii = (from: number, to: number) => Buffer.from(buf.subarray(from, to)).toString("latin1");
  if (buf.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Read one image inside the folder: size checked before reading, type from its bytes. Throws with a plain reason. */
export async function loadImage(file: string, cwd: string): Promise<ImageAttachment> {
  const full = await assertInsideCwd(file, cwd);
  const info = await stat(full);
  if (!info.isFile()) throw new Error(`${file} is not a file`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`${file} is ${formatKb(info.size)}; images are limited to ${formatKb(MAX_IMAGE_BYTES)}`);
  const buf = await readFile(full);
  const mediaType = sniffImage(buf);
  if (!mediaType) throw new Error(`${file} is not a PNG, JPEG, GIF or WebP image`);
  return { path: file, mediaType, bytes: buf.length, data: buf.toString("base64") };
}

function formatKb(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** What history keeps (and what the model reads next to the image). */
export function imageNote(image: Pick<ImageAttachment, "path" | "mediaType" | "bytes">) {
  return `[image: ${image.path}, ${image.mediaType}, ${formatKb(image.bytes)}. Sent with this message only; mention it again to re-send]`;
}

/** Width × height from the header (PNG IHDR, JPEG SOF, GIF, WebP VP8/VP8L/VP8X), or undefined. */
export function imageSize(buf: Uint8Array): { width: number; height: number } | undefined {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = sniffImage(b);
  try {
    if (type === "image/png" && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (type === "image/gif" && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (type === "image/webp" && b.length >= 30) {
      const chunk = b.toString("latin1", 12, 16);
      if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L" && b.length >= 25) {
        const bits = b.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
    }
    if (type === "image/jpeg") {
      // Walk the markers to the first start-of-frame (bounded by the buffer; each step moves forward).
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1]!;
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          i += 2;
          continue;
        }
        const length = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        }
        if (length < 2) return undefined;
        i += 2 + length;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A rough token cost (providers scale big images down; about 750 pixels per token, at most ~1600). */
export function estimateImageTokens(image: Pick<ImageAttachment, "data">) {
  const size = imageSize(Buffer.from(image.data.slice(0, 87_380), "base64"));
  if (!size || !size.width || !size.height) return 1600;
  return Math.min(1600, Math.max(85, Math.ceil((size.width * size.height) / 750)));
}

/**
 * Can this model see images? The big model families (OpenAI responses, Anthropic messages, Gemini) can; of the
 * rest, only ids that say so (vision, -vl). Jev and the local planner cannot.
 */
export function modelSeesImages(modelId: string) {
  const id = normalizeModelId(modelId);
  const api = inferEntry(id).api;
  if (api === "responses" || api === "messages" || api === "gemini") return !/^qwen/.test(id) || /vl|vision|omni/.test(id);
  if (api === "chat") return /vision|(?:^|[-.])vl(?:$|[-.])|omni/.test(id);
  return false;
}

/**
 * Image paths typed or pasted into the prompt without "@": Explorer's "Copy as path" adds quotes, so
 * "C:\proj\shot.png" and plain shots/err.png both count. Only as a hint; the caller checks the file.
 */
export function pastedImagePaths(prompt: string) {
  const found: string[] = [];
  const re = /"([^"\r\n]+?\.(?:png|jpe?g|gif|webp))"|'([^'\r\n]+?\.(?:png|jpe?g|gif|webp))'|(?:^|\s)([^\s"'@`<>|]+?\.(?:png|jpe?g|gif|webp))(?=$|[\s,;:!?)\]])/gi;
  for (const match of prompt.matchAll(re)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (raw && !found.includes(raw)) found.push(raw);
  }
  return found;
}

/** For display: a path relative to the folder when it is inside, else as given. */
export function shownPath(file: string, cwd: string) {
  const relative = path.relative(cwd, path.resolve(cwd, file));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : file;
}
