import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspacePaths } from "../config/paths.ts";

export async function saveAttachment(
  cwd: string,
  fileName: string,
  download: () => Promise<ArrayBuffer>,
): Promise<string> {
  const paths = workspacePaths(cwd);
  const receipt = randomUUID();
  let safeName = (fileName.split(/[\\/]/).at(-1) ?? "attachment")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "");
  if (
    !safeName ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safeName)
  )
    safeName = `file_${safeName || "attachment"}`;
  const temporary = join(paths.tmp, `${receipt}.download`);
  const directory = join(paths.attachments, receipt);
  await mkdir(paths.tmp, { recursive: true });
  try {
    const data = await download();
    await writeFile(temporary, Buffer.from(data), { flag: "wx" });
    await mkdir(directory, { recursive: true });
    const target = join(directory, safeName);
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}
