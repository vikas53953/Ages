import { writeFileInsideCwd } from "../env.js";
export async function writePath(relativePath, contents, cwd) {
    await writeFileInsideCwd(relativePath, contents, cwd);
    return `wrote ${relativePath} (${contents.length} bytes)`;
}
