/**
 * Images in a prompt ("why does @shots/error.png say this?", or a pasted path): read through the lock like any
 * file, recognised by their first bytes (never the extension), capped, and sent to the model only in the turn
 * they are attached. Saved history keeps a one-line note instead of the bytes, so sessions stay small and a
 * later rule change is respected the next time the image is attached.
 */
import { open } from "node:fs/promises";
import path from "node:path";
import { inferEntry, normalizeModelId } from "./catalog.js";
import { assertInsideCwd } from "./env.js";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_TURN = 4;
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp)$/i;
/** Only a hint for which path to take: the first bytes decide. */
export function isImagePath(file) {
    return IMAGE_EXTENSIONS.test(file);
}
/** The image type from its first bytes, or undefined (an SVG, a text file named .png, anything else). */
export function sniffImage(buf) {
    const at = (i) => buf[i];
    if (buf.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a)
        return "image/png";
    if (buf.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff)
        return "image/jpeg";
    const ascii = (from, to) => Buffer.from(buf.subarray(from, to)).toString("latin1");
    if (buf.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a"))
        return "image/gif";
    if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
        return "image/webp";
    return undefined;
}
/** Read one image inside the folder: size checked before reading, type from its bytes. Throws with a plain reason. */
export async function loadImage(file, cwd) {
    const full = await assertInsideCwd(file, cwd);
    // One open file: the size checked is the size read, even if the file changes meanwhile.
    const handle = await open(full, "r");
    let buf;
    try {
        const info = await handle.stat();
        if (!info.isFile())
            throw new Error(`${file} is not a file`);
        if (info.size > MAX_IMAGE_BYTES)
            throw new Error(`${file} is ${formatKb(info.size)}; images are limited to ${formatKb(MAX_IMAGE_BYTES)}`);
        const room = Buffer.alloc(MAX_IMAGE_BYTES + 1);
        let length = 0;
        for (;;) {
            const { bytesRead } = await handle.read(room, length, room.length - length, length);
            if (!bytesRead)
                break;
            length += bytesRead;
            if (length > MAX_IMAGE_BYTES)
                throw new Error(`${file} grew past ${formatKb(MAX_IMAGE_BYTES)} while it was read`);
        }
        buf = room.subarray(0, length);
    }
    finally {
        await handle.close();
    }
    const mediaType = sniffImage(buf);
    if (!mediaType)
        throw new Error(`${file} is not a PNG, JPEG, GIF or WebP image`);
    return { path: file, mediaType, bytes: buf.length, data: buf.toString("base64") };
}
function formatKb(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
/** What history keeps (and what the model reads next to the image). */
export function imageNote(image) {
    // The path quoted: a file name cannot pass itself off as the note's own words.
    return `[image: ${JSON.stringify(image.path)}, ${image.mediaType}, ${formatKb(image.bytes)}, about ${estimateImageTokens(image)} tokens. Sent with this message only; mention it again to re-send]`;
}
/** Width × height from the header (PNG IHDR, JPEG SOF, GIF, WebP VP8/VP8L/VP8X), or undefined. */
export function imageSize(buf) {
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const type = sniffImage(b);
    try {
        if (type === "image/png" && b.length >= 24)
            return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
        if (type === "image/gif" && b.length >= 10)
            return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
        if (type === "image/webp" && b.length >= 30) {
            const chunk = b.toString("latin1", 12, 16);
            if (chunk === "VP8X")
                return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
            if (chunk === "VP8 ")
                return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
            if (chunk === "VP8L" && b.length >= 25) {
                const bits = b.readUInt32LE(21);
                return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
            }
        }
        if (type === "image/jpeg") {
            // Walk the markers to the first start-of-frame (bounded by the buffer; each step moves forward).
            let i = 2;
            while (i + 9 < b.length) {
                if (b[i] !== 0xff)
                    return undefined;
                const marker = b[i + 1];
                if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
                    i += 2;
                    continue;
                }
                const length = b.readUInt16BE(i + 2);
                if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
                }
                if (length < 2)
                    return undefined;
                i += 2 + length;
            }
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
/** A rough token cost (providers scale big images down; about 750 pixels per token, at most ~1600). */
export function estimateImageTokens(image) {
    const size = imageSize(Buffer.from(image.data.slice(0, 87_380), "base64"));
    if (!size || !size.width || !size.height)
        return 1600;
    return Math.min(1600, Math.max(85, Math.ceil((size.width * size.height) / 750)));
}
/**
 * Can this model see images? The big model families (OpenAI responses, Anthropic messages, Gemini) can; of the
 * rest, only ids that say so (vision, -vl). Jev and the local planner cannot.
 */
export function modelSeesImages(modelId) {
    // "openai/gpt-5.5", "anthropic/claude-sonnet-5": the vendor prefix does not change the model.
    const id = normalizeModelId(modelId).replace(/^[a-z0-9-]+\//, "");
    // Families that see images from these versions on (Qwen 3.5+, Kimi K2.5+ are natively multimodal).
    const qwen = /^qwen(\d+)\.?(\d*)/.exec(id);
    if (qwen)
        return Number(`${qwen[1]}.${qwen[2] || 0}`) >= 3.5 || /vl|vision|omni/.test(id);
    const kimi = /^kimi-k(\d+)\.?(\d*)/.exec(id);
    if (kimi)
        return Number(`${kimi[1]}.${kimi[2] || 0}`) >= 2.5;
    const api = inferEntry(id).api;
    if (api === "responses" || api === "messages" || api === "gemini")
        return true;
    if (api === "chat")
        return /vision|(?:^|[-.])vl(?:$|[-.])|omni/.test(id);
    return false;
}
/**
 * Image paths typed or pasted into the prompt without "@": Explorer's "Copy as path" adds quotes, so
 * "C:\proj\shot.png" and plain shots/err.png both count. Only as a hint; the caller checks the file.
 */
export function pastedImagePaths(prompt) {
    const found = [];
    const re = /"([^"\r\n]+?\.(?:png|jpe?g|gif|webp))"|'([^'\r\n]+?\.(?:png|jpe?g|gif|webp))'|(?:^|\s)([^\s"'@`<>|]+?\.(?:png|jpe?g|gif|webp))(?=$|[\s,;:!?)\]])/gi;
    for (const match of prompt.matchAll(re)) {
        const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
        if (raw && !found.includes(raw))
            found.push(raw);
    }
    return found;
}
/** For display: a path relative to the folder when it is inside, else as given. */
export function shownPath(file, cwd) {
    const relative = path.relative(cwd, path.resolve(cwd, file));
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : file;
}
