import { readFile } from "node:fs/promises";
import { assertInsideCwd, writeFileInsideCwd } from "../env.ts";

export async function editPath(
  relativePath: string,
  oldString: string,
  newString: string,
  cwd: string,
) {
  if (!oldString) throw new Error("old_string is empty");
  const target = await assertInsideCwd(relativePath, cwd);
  const body = await readFile(target, "utf8");
  const count = body.split(oldString).length - 1;
  if (count === 0) throw new Error(`old_string not found in ${relativePath}`);
  if (count > 1) {
    throw new Error(`old_string is not unique in ${relativePath} (${count} matches)`);
  }
  await writeFileInsideCwd(relativePath, body.replace(oldString, () => newString), cwd);
  return `edited ${relativePath}`;
}
