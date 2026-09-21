import { writeFileInsideCwd } from "../env.ts";

export async function writePath(relativePath: string, contents: string, cwd: string) {
  await writeFileInsideCwd(relativePath, contents, cwd);
  return `wrote ${relativePath} (${contents.length} bytes)`;
}
