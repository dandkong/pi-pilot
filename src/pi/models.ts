import type { ModelInfo } from "./types.ts";
export function compareModels(a: ModelInfo, b: ModelInfo): number {
  return (
    a.provider.localeCompare(b.provider) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}
