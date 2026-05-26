import { Context, Data, Effect, Layer } from "effect";

import { WorkerEnvironment } from "./Environment";
import type { WorkerEnv } from "./Environment";

/** Internal type id marker used by binding helper services. */
export const TypeId = "effect-cf/Binding" as const;

/** Error raised when a configured binding does not exist on `env`. */
export class BindingNotFoundError extends Data.TaggedError("BindingNotFoundError")<{
  readonly binding: string;
  readonly message: string;
}> {}

/** Error raised when a binding exists but does not match the expected shape. */
export class BindingValidationError extends Data.TaggedError("BindingValidationError")<{
  readonly binding: string;
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
}> {}

export interface ValidationOptions {
  readonly expected?: string;
}

const defaultExpected = "Cloudflare binding resource";

const isPropertyTarget = (value: unknown): value is object =>
  (typeof value === "object" || typeof value === "function") && value !== null;

const getObjectName = (value: object | Function): string => {
  const tag = (() => {
    try {
      return Object.prototype.toString.call(value).slice("[object ".length, -1);
    } catch {
      return typeof value;
    }
  })();
  const constructorName = (() => {
    try {
      return "constructor" in value &&
        typeof value.constructor === "function" &&
        typeof value.constructor.name === "string"
        ? value.constructor.name
        : undefined;
    } catch {
      return undefined;
    }
  })();

  if (tag !== "Object") {
    return tag;
  }

  if (constructorName !== undefined && constructorName !== "" && constructorName !== "Object") {
    return constructorName;
  }

  return tag;
};

const propertyNames = (value: object | Function): ReadonlyArray<string> => {
  const names = new Set<string>();

  for (const target of [value, Object.getPrototypeOf(value)] as const) {
    if (target === null || target === Object.prototype || target === Function.prototype) {
      continue;
    }

    try {
      for (const name of Object.getOwnPropertyNames(target)) {
        names.add(name);
      }
    } catch {
      continue;
    }
  }

  return [...names].filter((name) => name !== "constructor").sort();
};

const isMethod = (value: object | Function, name: string): boolean => {
  try {
    return typeof Reflect.get(value, name) === "function";
  } catch {
    return false;
  }
};

const describeActual = (value: unknown): string => {
  if (value === null) {
    return "null";
  }

  if (typeof value !== "object" && typeof value !== "function") {
    return typeof value;
  }

  const names = propertyNames(value);
  const methods = names.filter((name) => isMethod(value, name));
  const properties = names.filter((name) => !methods.includes(name));
  const details = [
    methods.length > 0 ? `methods ${methods.join(", ")}` : undefined,
    properties.length > 0 ? `properties ${properties.join(", ")}` : undefined,
  ].filter((detail) => detail !== undefined);

  if (details.length === 0) {
    return getObjectName(value);
  }

  return `${getObjectName(value)} with ${details.join("; ")}`;
};

const getBinding = <Resource>(
  env: WorkerEnv,
  binding: string,
  isResource: (value: unknown) => value is Resource,
  options?: ValidationOptions,
): Effect.Effect<Resource, BindingNotFoundError | BindingValidationError> =>
  Effect.gen(function* () {
    if (!isPropertyTarget(env)) {
      const actual = describeActual(env);
      return yield* Effect.fail(
        new BindingValidationError({
          binding,
          expected: "WorkerEnvironment object",
          actual,
          message: `Cloudflare binding "${binding}" failed validation. Expected WorkerEnvironment object; got ${actual}`,
        }),
      );
    }

    const resource = Reflect.get(env, binding);

    if (resource === undefined) {
      return yield* Effect.fail(
        new BindingNotFoundError({
          binding,
          message: `Cloudflare binding "${binding}" was not found in WorkerEnvironment`,
        }),
      );
    }

    if (!isResource(resource)) {
      const expected = options?.expected ?? defaultExpected;
      const actual = describeActual(resource);
      return yield* Effect.fail(
        new BindingValidationError({
          binding,
          expected,
          actual,
          message: `Cloudflare binding "${binding}" failed validation. Expected ${expected}; got ${actual}`,
        }),
      );
    }

    return resource;
  });

/**
 * Creates a Context tag + layer for reading and validating a Cloudflare binding.
 */
export interface BindingService<Self, Id extends string, Service> extends Context.ServiceClass<
  Self,
  Id,
  Service
> {
  readonly [TypeId]: typeof TypeId;
  readonly binding: string;
  readonly layer: Layer.Layer<
    Self,
    BindingNotFoundError | BindingValidationError,
    WorkerEnvironment
  >;
}

export const layer = <Self, Resource, Service = Resource>(
  tag: Context.Service<Self, Service>,
  binding: string,
  isResource: (value: unknown) => value is Resource,
  wrap?: (resource: Resource) => Service,
  options?: ValidationOptions,
): Layer.Layer<Self, BindingNotFoundError | BindingValidationError, WorkerEnvironment> =>
  Layer.effect(
    tag,
    Effect.gen(function* () {
      const env = yield* WorkerEnvironment;
      const resource = yield* getBinding(env, binding, isResource, options);
      return wrap === undefined ? (resource as unknown as Service) : wrap(resource);
    }),
  );

export const Service =
  <Self>() =>
  <Id extends string, Resource, Service = Resource>(
    id: Id,
    binding: string,
    isResource: (value: unknown) => value is Resource,
    wrap?: (resource: Resource) => Service,
    options?: ValidationOptions,
  ): BindingService<Self, Id, Service> => {
    const tag = Context.Service<Self, Service>()(id);
    const serviceLayer = layer(tag, binding, isResource, wrap, options);

    return Object.assign(tag, {
      [TypeId]: TypeId,
      binding,
      layer: serviceLayer,
    }) as BindingService<Self, Id, Service>;
  };
