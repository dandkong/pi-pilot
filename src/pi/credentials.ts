import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Type } from "typebox";
import type {
  AuthOperationOptions,
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { readJson } from "../config/files.ts";
import { object } from "../config/settings.ts";

const credentialSchema = Type.Union([
  object({
    type: Type.Literal("api_key"),
    key: Type.Optional(Type.String({ minLength: 1 })),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
  }),
  Type.Object({
    type: Type.Literal("oauth"),
    refresh: Type.String(),
    access: Type.String(),
    expires: Type.Number({ minimum: 0 }),
  }),
]);
const credentialsSchema = Type.Record(Type.String(), credentialSchema);
const writers = new Map<string, Promise<unknown>>();
const readers = new Map<string, Set<WeakRef<FileCredentialStore>>>();

/** One bot process owns a workspace; serialize all credential file writes in that process. */
export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  private values: Record<string, Credential>;
  constructor(path: string) {
    this.path = resolve(path);
    this.values = this.snapshot(); // Validate without altering an existing runtime's credentials.
    const references = readers.get(this.path) ?? new Set();
    references.add(new WeakRef(this));
    readers.set(this.path, references);
  }
  private snapshot(): Record<string, Credential> {
    return readJson(this.path, credentialsSchema, {}) as Record<
      string,
      Credential
    >;
  }
  async read(provider: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return Object.hasOwn(this.values, provider)
      ? structuredClone(this.values[provider])
      : undefined;
  }
  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return Object.entries(this.values).map(([providerId, value]) => ({
      providerId,
      type: value.type,
    }));
  }
  private publish(values: Record<string, Credential>): void {
    const references = readers.get(this.path);
    for (const reference of references ?? []) {
      const store = reference.deref();
      if (store) store.values = structuredClone(values);
      else references?.delete(reference);
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (writers.get(this.path) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    writers.set(this.path, pending);
    void pending
      .finally(() => {
        if (writers.get(this.path) === pending) writers.delete(this.path);
      })
      .catch(() => {});
    return pending;
  }
  private async save(values: Record<string, Credential>) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(values, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  modify(
    provider: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    return this.serialize(async () => {
      options?.signal?.throwIfAborted();
      const values = this.snapshot();
      const current = Object.hasOwn(values, provider)
        ? values[provider]
        : undefined;
      const next = await fn(structuredClone(current));
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        Object.defineProperty(values, provider, {
          value: next,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        await this.save(values);
      }
      this.publish(values);
      return next ?? current;
    });
  }
  delete(provider: string, options?: AuthOperationOptions) {
    return this.serialize(async () => {
      options?.signal?.throwIfAborted();
      const values = this.snapshot();
      if (Object.hasOwn(values, provider)) {
        delete values[provider];
        await this.save(values);
      }
      this.publish(values);
    });
  }
}
