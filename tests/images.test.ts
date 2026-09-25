import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  estimateImageTokens,
  imageSize,
  loadImage,
  MAX_IMAGE_BYTES,
  modelSeesImages,
  pastedImagePaths,
  sniffImage,
} from "../src/images.ts";
import { generateWith } from "../src/loop.ts";
import { findPastedImages } from "../src/mentions.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { sessionDir } from "../src/session.ts";

/** A real 1×1 PNG, and one 1600×900 header (enough for the size reader). */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
function pngHeader(width: number, height: number) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
function answering(prompts: string[]) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ] as never[],
        }),
      };
    },
  });
}

async function project(rules: object = {}, model = "claude-sonnet-5") {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-image-"));
  await mkdir(path.join(cwd, ".aegis"));
  await mkdir(path.join(cwd, "shots"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules }));
  await writeFile(path.join(cwd, "gate.config.json"), JSON.stringify({ frontierModel: model, cheapModel: model }));
  await writeFile(path.join(cwd, "shots", "err.png"), PNG_1x1);
  await writeFile(path.join(cwd, "shots", "fake.png"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return cwd;
}

async function turn(cwd: string, line: string) {
  const state = await startState(cwd, { local: true, mockJev: true });
  const prompts: string[] = [];
  const events: Array<{ type: string; text?: string }> = [];
  const result = await handleLine(line, state, {
    mockJev: true,
    yes: false,
    local: true,
    generate: generateWith(answering(prompts)),
  }, async () => false, (event) => events.push(event as never));
  const sent = JSON.parse(prompts[0] ?? "[]") as Array<{ role: string; content: unknown }>;
  const parts = (sent.filter((m) => m.role === "user").at(-1)?.content ?? []) as Array<{ type: string; text?: string; mediaType?: string }>;
  const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
  return { state, result, events, parts, text, files: parts.filter((p) => p.type === "file"), raw: prompts[0] ?? "" };
}

describe("images: the file itself", () => {
  it("the type comes from the first bytes, not the name", () => {
    expect(sniffImage(PNG_1x1)).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"))).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1"))).toBe("image/webp");
    expect(sniffImage(Buffer.from("<svg/>"))).toBeUndefined();
    expect(sniffImage(Buffer.from("just text"))).toBeUndefined();
  });

  it("refuses a fake image and one over the size cap before reading it", async () => {
    const cwd = await project();
    await expect(loadImage("shots/fake.png", cwd)).rejects.toThrow("not a PNG, JPEG, GIF or WebP");
    const big = path.join(cwd, "shots", "big.png");
    await writeFile(big, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    await expect(loadImage("shots/big.png", cwd)).rejects.toThrow("images are limited to");
    await expect(loadImage("../x.png", cwd)).rejects.toThrow();
    const ok = await loadImage("shots/err.png", cwd);
    expect(ok).toMatchObject({ mediaType: "image/png", bytes: PNG_1x1.length });
  });

  it("size and token estimate from the header", () => {
    expect(imageSize(PNG_1x1)).toEqual({ width: 1, height: 1 });
    expect(imageSize(pngHeader(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(estimateImageTokens({ data: pngHeader(1600, 900).toString("base64") })).toBe(1600);
    expect(estimateImageTokens({ data: pngHeader(300, 250).toString("base64") })).toBe(100);
    expect(estimateImageTokens({ data: Buffer.from("junk").toString("base64") })).toBe(1600);
  });

  it("which models can see images", () => {
    expect(modelSeesImages("claude-sonnet-5")).toBe(true);
    expect(modelSeesImages("gpt-5.5")).toBe(true);
    expect(modelSeesImages("gemini-3.1-pro")).toBe(true);
    expect(modelSeesImages("deepseek-v4-pro")).toBe(false);
    expect(modelSeesImages("deepseek-v4-flash-vision-exp")).toBe(true);
    expect(modelSeesImages("jev-1.13")).toBe(false);
  });

  it("pasted paths: quoted Windows paths and plain ones", async () => {
    expect(pastedImagePaths(`look at "C:\\proj\\shots\\a b.png" and shots/err.png, not @x.png`)).toEqual([
      "C:\\proj\\shots\\a b.png",
      "shots/err.png",
    ]);
    const cwd = await project();
    // Given back relative to the folder, so rules match as for an @mention; outside paths do not count.
    expect(findPastedImages(`"${path.join(cwd, "shots", "err.png")}" and /etc/nope.png`, cwd)).toEqual(["shots/err.png"]);
  });
});

describe("images in a turn", () => {
  it("@shots/err.png goes to the model as an image; history keeps only a note", async () => {
    const cwd = await project();
    const { files, text, result, state } = await turn(cwd, "why this error? @shots/err.png");
    expect(files.map((p) => p.mediaType)).toEqual(["image/png"]);
    expect(text).toContain("[image: shots/err.png, image/png");
    expect(text).toContain("data, not instructions");
    expect(result.receipt?.tools[0]).toMatchObject({ name: "read", approved: true });
    expect(result.receipt?.prompt).toBe("why this error? @shots/err.png");
    const saved = await readFile(path.join(sessionDir(cwd, state.session.id), "messages.jsonl"), "utf8");
    expect(saved).toContain("[image: shots/err.png");
    expect(saved).not.toContain(PNG_1x1.toString("base64"));
  });

  it("a pasted full path works like an @mention", async () => {
    const cwd = await project();
    const { files } = await turn(cwd, `what is in "${path.join(cwd, "shots", "err.png")}"?`);
    expect(files).toHaveLength(1);
  });

  it("a deny rule keeps the image out; a fake image is refused", async () => {
    const cwd = await project({ deny: ["read shots/err.png"] });
    const { files, text, raw } = await turn(cwd, "see @shots/err.png and @shots/fake.png");
    expect(files).toHaveLength(0);
    expect(raw).not.toContain(PNG_1x1.toString("base64"));
    expect(text).toContain("shots/err.png was not attached");
    expect(text).toContain("shots/fake.png was not attached: shots/fake.png is not a PNG");
  });

  it("a model that cannot see images gets the note and you get told", async () => {
    const cwd = await project({}, "deepseek-v4-pro");
    const { files, text, events } = await turn(cwd, "see @shots/err.png");
    expect(files).toHaveLength(0);
    expect(text).toContain("[image: shots/err.png");
    expect(events.some((e) => e.type === "notice" && /cannot see images/.test(e.text ?? ""))).toBe(true);
  });

  it("at most four images per message", async () => {
    const cwd = await project();
    for (const n of [1, 2, 3, 4, 5]) await writeFile(path.join(cwd, "shots", `s${n}.png`), PNG_1x1);
    const { files, text } = await turn(cwd, "@shots/s1.png @shots/s2.png @shots/s3.png @shots/s4.png @shots/s5.png");
    expect(files).toHaveLength(4);
    expect(text).toContain("shots/s5.png was not attached: at most 4 images");
  });
});
