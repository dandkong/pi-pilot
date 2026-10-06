import { mkdir, mkdtemp } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  err,
  FileError,
  ok,
  type Result,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** Keep tool output spill files and child-process temporary files in the workspace. */
export class WorkspaceExecutionEnv extends NodeExecutionEnv {
  constructor(
    cwd: string,
    private readonly temporaryDirectory: string,
  ) {
    super({
      cwd,
      shellEnv: {
        ...process.env,
        TMPDIR: temporaryDirectory,
        TMP: temporaryDirectory,
        TEMP: temporaryDirectory,
      },
    });
    mkdirSync(temporaryDirectory, { recursive: true });
  }
  override async createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    if (context.abortSignal?.aborted)
      return err(new FileError("aborted", "aborted"));
    const name = prefix ?? "tmp-";
    if (/[\\/]/.test(name))
      return err(
        new FileError("invalid", "Invalid temporary directory prefix"),
      );
    try {
      await mkdir(this.temporaryDirectory, { recursive: true });
      return ok(await mkdtemp(join(this.temporaryDirectory, name)));
    } catch (error) {
      return err(
        new FileError(
          "unknown",
          error instanceof Error
            ? error.message
            : "Cannot create workspace temporary directory",
        ),
      );
    }
  }
}
