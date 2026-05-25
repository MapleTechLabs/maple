import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";

import * as Hyperdrive from "./Hyperdrive";

export type PgLayerOptions = Omit<
  PgClient.PgClientConfig & { readonly acquireForStream?: boolean },
  "url" | "host" | "port" | "path" | "ssl" | "database" | "username" | "password" | "stream"
>;

export const layer = <Self, Id extends string>(
  tag: Hyperdrive.TagClass<Self, Id>,
  binding: Hyperdrive.LayerOptions,
  options?: PgLayerOptions,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const hyperdrive = yield* tag;

      return PgClient.layerFrom(
        PgClient.makeClient({
          ...options,
          url: Redacted.make(hyperdrive.connectionString),
        }),
      );
    }),
  ).pipe(Layer.provide(tag.layer(binding)));
