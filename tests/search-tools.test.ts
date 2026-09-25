import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { globPath, grepPath, walkFiles } from "../src/tools/grep.ts";
import { readPath } from "../src/tools/read.ts";

async function project() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-search-"));
  await mkdir(path.join(cwd, "src", "deep"), { recursive: true });
  await mkdir(path.join(cwd, "build"), { recursive: true });
  await writeFile(path.join(cwd, ".gitignore"), "build/\n*.log\n!keep.log\n");
  await writeFile(path.join(cwd, "src", "a.ts"), "const Alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n");
  await writeFile(path.join(cwd, "src", "deep", "b.ts"), "export const alpha = 'x';\n");
  await writeFile(path.join(cwd, "src", "notes.md"), "alpha notes\n");
  await writeFile(path.join(cwd, "build", "out.ts"), "const alpha = 'built';\n");
  await writeFile(path.join(cwd, "debug.log"), "alpha in a log\n");
  await writeFile(path.join(cwd, "keep.log"), "alpha kept\n");
  await writeFile(path.join(cwd, "image.bin"), Buffer.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0x00, 0x01]));
  return cwd;
}

describe("grep", () => {
  it("honours .gitignore (and its !), skips binaries, and can be case-sensitive or limited by glob", async () => {
    const cwd = await project();
    const all = await grepPath("alpha", ".", cwd);
    expect(all).toContain("src/a.ts:1:const Alpha = 1;");
    expect(all).toContain("src/deep/b.ts:1:");
    expect(all).toContain("keep.log:1:");
    expect(all).not.toContain("build/out.ts");
    expect(all).not.toContain("debug.log");
    expect(all).not.toContain("image.bin");
    expect(await grepPath("alpha", ".", cwd, { caseSensitive: true })).not.toContain("src/a.ts");
    const onlyTs = await grepPath("alpha", ".", cwd, { glob: "*.ts" });
    expect(onlyTs).not.toContain("notes.md");
    expect(onlyTs).toContain("src/deep/b.ts");
    expect(await grepPath("beta", "src", cwd, { context: 1 })).toContain("src/a.ts-1-const Alpha = 1;\nsrc/a.ts:2:const beta = 2;\nsrc/a.ts-3-const gamma = 3;");
    expect(await grepPath("(", ".", cwd)).toContain("bad pattern");
  });

  it("says how many matches it did not show", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-search-many-"));
    await writeFile(path.join(cwd, "many.txt"), Array.from({ length: 150 }, (_, i) => `hit ${i}`).join("\n"));
    expect(await grepPath("hit", ".", cwd)).toContain("[… 50 more matches not shown");
  });
});

describe("glob and read", () => {
  it("glob lists matching files, skipping ignored ones", async () => {
    const cwd = await project();
    const found = (await globPath("**/*.ts", ".", cwd)).split("\n").sort();
    expect(found).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(await globPath("src/*.md", ".", cwd)).toBe("src/notes.md");
    expect(await globPath("*.py", ".", cwd)).toBe("no files match");
  });

  it("read takes offset and limit for big files, and marks folders", async () => {
    const cwd = await project();
    await writeFile(path.join(cwd, "big.txt"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
    expect(await readPath("big.txt", cwd, { offset: 10, limit: 2 })).toBe("10  line 10\n11  line 11\n[lines 10-11 of 30]");
    expect(await readPath("src", cwd)).toContain("deep/");
  });
});

describe("paths shown from the real folder", () => {
  it("a folder reached by another spelling (a link here, an 8.3 short name on Windows) still shows src/… paths", async () => {
    const real = await project();
    const alias = path.join(await mkdtemp(path.join(os.tmpdir(), "aegis-search-alias-")), "proj");
    try {
      await symlink(real, alias, "junction");
    } catch {
      return; // no link rights
    }
    expect(await grepPath("beta", ".", alias)).toBe("src/a.ts:2:const beta = 2;");
    expect((await globPath("**/*.ts", ".", alias)).split("\n").sort()).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });
});

describe("nested .gitignore files", () => {
  it("a subfolder's .gitignore applies below it and can re-include what a parent ignored", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-nested-ignore-"));
    await mkdir(path.join(cwd, "pkg", "gen"), { recursive: true });
    await mkdir(path.join(cwd, "other"), { recursive: true });
    await writeFile(path.join(cwd, ".gitignore"), "*.snap\n");
    await writeFile(path.join(cwd, "pkg", ".gitignore"), "gen/\n!keep.snap\n/local.txt\n");
    await writeFile(path.join(cwd, "pkg", "gen", "x.ts"), "hit\n");
    await writeFile(path.join(cwd, "pkg", "keep.snap"), "hit\n");
    await writeFile(path.join(cwd, "pkg", "drop.snap"), "hit\n");
    await writeFile(path.join(cwd, "pkg", "local.txt"), "hit\n");
    await writeFile(path.join(cwd, "pkg", "a.ts"), "hit\n");
    await writeFile(path.join(cwd, "other", "local.txt"), "hit\n");
    const files = (await walkFiles(cwd)).map((f) => f.relative).sort();
    expect(files).toEqual([".gitignore", "other/local.txt", "pkg/.gitignore", "pkg/a.ts", "pkg/keep.snap"]);
  });
});
