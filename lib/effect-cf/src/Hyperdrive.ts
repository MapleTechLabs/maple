import { Context, Effect, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

const expectedHyperdrive = "Hyperdrive binding with connectionString";

/** Typed Hyperdrive binding definition. */
export interface HyperdriveDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

export interface HyperdriveClient {
  readonly connectionString: string;
  readonly unsafeRaw: Effect.Effect<Hyperdrive>;
  readonly definition: HyperdriveDefinition;
}

declare const HyperdriveServiceTypeId: unique symbol;

/** Nominal service marker for Hyperdrive services created with {@link make}. */
export interface HyperdriveService<Id extends string> {
  readonly [HyperdriveServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  HyperdriveClient
> {
  readonly id: Id;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >;
}

export const isHyperdrive = (value: unknown): value is Hyperdrive => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const resource = value as Record<string, unknown>;

  return typeof resource.connectionString === "string";
};

export const makeClient =
  (definition: HyperdriveDefinition) =>
  (hyperdrive: Hyperdrive): HyperdriveClient => ({
    definition,
    connectionString: hyperdrive.connectionString,
    unsafeRaw: Effect.succeed(hyperdrive),
  });

export const layer = <Self>(
  tag: Context.Service<Self, HyperdriveClient>,
  definition: HyperdriveDefinition,
) =>
  Binding.layer(tag, definition.binding, isHyperdrive, makeClient(definition), {
    expected: expectedHyperdrive,
  });

export const make = <Id extends string>(id: Id) => Tag<HyperdriveService<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, HyperdriveClient>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
