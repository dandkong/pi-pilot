import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Extension, Registry } from "@earendil-works/pi-durable";
import { workspacePaths } from "../config/paths.ts";
import { logger } from "../logger.ts";

export type WorkspacePlugin = { name: string; path: string; tools: string[] };
export type WorkspaceRegistry = {
  registry: Registry;
  plugins: WorkspacePlugin[];
  dispose(): Promise<void>;
};

const entrySuffixes = [".ts", ".js", ".mjs"];
const hostImport =
  /^(?:@earendil-works\/(?:pi-durable|pi-ai|chord)|typebox)(?:\/|$)/;

async function discover(cwd: string): Promise<string[]> {
  const root = workspacePaths(cwd).extensions;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Cannot read extensions directory: ${root}`);
  }
  const paths: string[] = [];
  for (const entry of entries.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    const info = entry.isSymbolicLink() ? await stat(path) : entry;
    if (info.isFile() && entrySuffixes.includes(extname(entry.name)))
      paths.push(path);
    else if (info.isDirectory()) {
      for (const suffix of entrySuffixes) {
        const candidate = join(path, `index${suffix}`);
        try {
          if ((await stat(candidate)).isFile()) {
            paths.push(candidate);
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw new Error(`Cannot read plugin entry: ${candidate}`);
        }
      }
    }
  }
  return paths;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function validate(value: unknown, path: string): asserts value is Extension {
  const fail = (detail: string): never => {
    throw new Error(`Invalid plugin ${path}: ${detail}`);
  };
  if (!record(value) || typeof value.name !== "string" || !value.name.trim())
    fail("default export must be a named durable Extension object");
  const extension = value as Record<string, unknown>;
  for (const field of ["tools", "sections", "hooks", "wraps", "tasks"]) {
    const members = extension[field];
    if (members === undefined) continue;
    if (!Array.isArray(members)) fail(`${field} must be an array`);
    for (const member of members as unknown[]) {
      if (!record(member)) fail(`Invalid ${field} member`);
      const item = member as Record<string, unknown>;
      if (
        field === "tools" &&
        (typeof item.name !== "string" ||
          !item.name ||
          typeof item.description !== "string" ||
          !record(item.parameters) ||
          typeof item.execute !== "function")
      )
        fail("Tool requires name, description, parameters and execute");
      if (
        field === "sections" &&
        (typeof item.key !== "string" || typeof item.render !== "function")
      )
        fail("Section requires key and render");
      if (
        field === "hooks" &&
        (typeof item.task !== "string" || !record(item.handlers))
      )
        fail("Hook requires task and handlers");
      if (
        field === "wraps" &&
        (typeof item.wrap !== "function" ||
          (typeof item.tool !== "string" && typeof item.section !== "string"))
      )
        fail("Wrapper requires tool/section and wrap");
      if (
        field === "tasks" &&
        (!record(item.definition) ||
          typeof item.definition.name !== "string" ||
          !record(item.definition.phases))
      )
        fail("Task requires a durable task definition");
    }
  }
}

/** Fresh local bundles reload transitive helpers while sharing the host's pi/chord modules. */
async function compile(
  entry: string,
  directory: string,
  index: number,
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    throw: false,
    plugins: [
      {
        name: "pilot-extension-imports",
        setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, (args) => {
            if (
              /^[A-Za-z]:[/\\]/.test(args.path) ||
              /^(?:node|bun):/.test(args.path)
            )
              return;
            const path = hostImport.test(args.path)
              ? fileURLToPath(import.meta.resolve(args.path))
              : Bun.resolveSync(args.path, dirname(args.importer));
            return { path, external: true };
          });
          builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
            const suffix = extname(path);
            const loader =
              suffix === ".tsx"
                ? "tsx"
                : suffix === ".jsx"
                  ? "jsx"
                  : /\.[cm]?ts$/.test(suffix)
                    ? "ts"
                    : "js";
            const transpiler = new Bun.Transpiler({
              loader,
              target: "bun",
              define: {
                "import.meta.dir": JSON.stringify(dirname(path)),
                "import.meta.dirname": JSON.stringify(dirname(path)),
                "import.meta.path": JSON.stringify(path),
                "import.meta.filename": JSON.stringify(path),
                "import.meta.file": JSON.stringify(basename(path)),
                "import.meta.url": JSON.stringify(pathToFileURL(path).href),
                "import.meta.main": "false",
              },
            });
            return {
              contents: transpiler.transformSync(await readFile(path, "utf8")),
              loader: "js",
            };
          });
        },
      },
    ],
  });
  if (!result.success || result.outputs.length !== 1)
    throw new Error(
      `Cannot compile plugin ${entry}. Check syntax and installed dependencies.`,
    );
  const path = join(directory, `${index}.mjs`);
  await writeFile(path, await result.outputs[0]!.text());
  return path;
}

export async function installWorkspacePlugins(
  cwd: string,
  registry: Registry,
): Promise<WorkspaceRegistry> {
  const entries = await discover(cwd);
  const plugins: WorkspacePlugin[] = [];
  let cache: string | undefined;
  const dispose = async () => {
    if (!cache) return;
    const tmp = resolve(workspacePaths(cwd).tmp);
    const inside = relative(tmp, resolve(cache));
    if (
      !inside ||
      isAbsolute(inside) ||
      inside.startsWith(`..${sep}`) ||
      inside === ".."
    )
      throw new Error("Refusing to remove plugin cache outside workspace tmp");
    try {
      await rm(cache, { recursive: true, force: true });
    } catch {
      // Cache cleanup must not report a successful runtime replacement as failed.
      logger.warn("Cannot remove workspace plugin cache", { path: cache });
    }
  };
  try {
    if (entries.length) {
      await mkdir(workspacePaths(cwd).tmp, { recursive: true });
      cache = await mkdtemp(join(workspacePaths(cwd).tmp, "extensions-"));
    }
    const names = new Set(
      registry
        .snapshot()
        .installed()
        .map((extension) => extension.name),
    );
    for (const [index, entry] of entries.entries()) {
      let extension: unknown;
      try {
        extension = (
          await import(pathToFileURL(await compile(entry, cache!, index)).href)
        ).default;
      } catch (error) {
        throw new Error(`Cannot load plugin ${entry}`, { cause: error });
      }
      validate(extension, entry);
      if (names.has(extension.name))
        throw new Error(
          `Duplicate or reserved extension name ${extension.name} in ${entry}`,
        );
      names.add(extension.name);
      try {
        registry.install(extension);
      } catch (error) {
        throw new Error(
          `Cannot register plugin ${entry}: ${error instanceof Error ? error.message : "invalid extension"}`,
        );
      }
      plugins.push({
        name: extension.name,
        path: entry,
        tools: (extension.tools ?? []).map((tool) => tool.name),
      });
    }
    return { registry, plugins, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
