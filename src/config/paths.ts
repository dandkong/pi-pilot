import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function workspacePaths(cwd: string) {
  const root = join(resolve(cwd), "pi-pilot");
  return {
    root,
    config: join(root, "config"),
    sessions: join(root, "sessions"),
    attachments: join(root, "attachments"),
    tmp: join(root, "tmp"),
    exports: join(root, "exports"),
    logs: join(root, "logs"),
  };
}

export function initializeWorkspace(cwd: string): void {
  const paths = workspacePaths(cwd);
  for (const path of [
    paths.config,
    paths.sessions,
    paths.attachments,
    paths.tmp,
  ])
    mkdirSync(path, { recursive: true });
  try {
    writeFileSync(join(paths.root, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
