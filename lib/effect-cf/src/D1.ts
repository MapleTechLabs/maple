import { D1Client } from "@effect/sql-d1";
import { Effect, Layer } from "effect";

import * as Binding from "./Binding";

const TypeId = "effect-cf/D1" as const;
const expectedD1Database = "D1 database binding with prepare(), batch(), and exec()";

/** Typed D1 binding definition. */
export interface D1Definition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

/** Options forwarded to `@effect/sql-d1` when building a SQL client layer. */
export type D1SqlLayerOptions = Omit<D1Client.D1ClientConfig, "db">;

declare const D1ServiceTypeId: unique symbol;

/** Nominal service marker for D1 services created with {@link make}. */
export interface D1Service<Id extends string> {
  readonly [D1ServiceTypeId]: {
    readonly id: Id;
  };
}

const isD1Database = (value: unknown): value is D1Database => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const resource = value as Record<string, unknown>;

  return (
    typeof resource.prepare === "function" &&
    typeof resource.batch === "function" &&
    typeof resource.exec === "function"
  );
};

/**
 * Creates a typed D1 service tag plus Effect helpers.
 */
export const make = <Id extends string>(id: Id, definition: D1Definition) =>
  Service<D1Service<Id>>()(id, definition);

/**
 * Builds a D1 service around a Cloudflare D1 database binding.
 *
 * The returned service exposes the raw `D1Database` binding and `sqlLayer(...)`
 * for providing `effect/unstable/sql` via `@effect/sql-d1`.
 *
 * @example
 * ```ts
 * class TodoDatabase extends D1.Service<TodoDatabase>()("TodoDatabase", {
 *   binding: "TODO_DB",
 * }) {}
 *
 * const SqlLive = TodoDatabase.sqlLayer();
 * ```
 */
export const Service =
  <Self>() =>
  <Id extends string>(id: Id, definition: D1Definition) => {
    const tag = Binding.Service<Self>()(id, definition.binding, isD1Database, undefined, {
      expected: expectedD1Database,
    });

    const sqlLayer = (options?: D1SqlLayerOptions) =>
      Layer.unwrap(
        Effect.gen(function* () {
          const db = yield* tag;
          return D1Client.layer({ ...options, db });
        }),
      ).pipe(Layer.provide(tag.layer));

    return Object.assign(tag, {
      [TypeId]: TypeId,
      definition,
      sqlLayer,
    });
  };
