import { Context, Data, Effect, Option, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

const TypeId = "effect-cf/Images/Steps" as const;
const expectedImagesBinding = "Images binding with info() and input()";

/** Error raised when a Cloudflare Images operation fails. */
export class ImagesOperationError extends Data.TaggedError("ImagesOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** Typed Cloudflare Images binding definition. */
export interface ImagesDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

export type ImageInfoResponse = globalThis.ImageInfoResponse;
export type ImageTransform = globalThis.ImageTransform;
export type ImageDrawOptions = globalThis.ImageDrawOptions;
export type ImageInputOptions = globalThis.ImageInputOptions;
export type ImageOutputOptions = globalThis.ImageOutputOptions;
export type ImageTransformationOutputOptions = globalThis.ImageTransformationOutputOptions;
export type ImageTransformationResult = globalThis.ImageTransformationResult;
export type ImageUploadOptions = globalThis.ImageUploadOptions;
export type ImageUpdateOptions = globalThis.ImageUpdateOptions;
export type ImageListOptions = globalThis.ImageListOptions;
export type ImageList = globalThis.ImageList;
export type ImageMetadata = globalThis.ImageMetadata;
export type ImageInputValue = ReadableStream<Uint8Array> | ArrayBuffer;
export type ImageUploadValue = ReadableStream<Uint8Array> | ArrayBuffer;

export interface DrawStepOptions {
  readonly image: ReadableStream<Uint8Array> | globalThis.ImageTransformer;
  readonly options?: ImageDrawOptions;
}

export type Step = Data.TaggedEnum<{
  readonly Transform: {
    readonly transform: ImageTransform;
  };
  readonly Draw: DrawStepOptions;
}>;

export interface Steps {
  readonly [TypeId]: typeof TypeId;
  readonly steps: ReadonlyArray<Step>;
}

export interface ProcessOptions {
  readonly stream: ImageInputValue;
  readonly inputOptions?: ImageInputOptions;
  readonly outputOptions: ImageOutputOptions;
}

export interface ImagesTransformationResultClient {
  readonly raw: globalThis.ImageTransformationResult;
  readonly response: Effect.Effect<globalThis.Response, ImagesOperationError>;
  readonly contentType: Effect.Effect<string, ImagesOperationError>;
  readonly image: (
    options?: ImageTransformationOutputOptions,
  ) => Effect.Effect<ReadableStream<Uint8Array>, ImagesOperationError>;
}

export interface ImageHandleClient {
  readonly raw: globalThis.ImageHandle;
  readonly details: Effect.Effect<Option.Option<ImageMetadata>, ImagesOperationError>;
  readonly bytes: Effect.Effect<Option.Option<ReadableStream<Uint8Array>>, ImagesOperationError>;
  readonly update: (
    options: ImageUpdateOptions,
  ) => Effect.Effect<ImageMetadata, ImagesOperationError>;
  readonly delete: Effect.Effect<boolean, ImagesOperationError>;
}

export interface HostedImagesClient {
  readonly image: (imageId: string) => ImageHandleClient;
  readonly upload: (
    image: ImageUploadValue,
    options?: ImageUploadOptions,
  ) => Effect.Effect<ImageMetadata, ImagesOperationError>;
  readonly list: (options?: ImageListOptions) => Effect.Effect<ImageList, ImagesOperationError>;
  readonly unsafeRaw: Effect.Effect<globalThis.HostedImagesBinding>;
}

export interface ImagesRuntimeBinding {
  readonly info: (
    image: ImageInputValue,
    options?: ImageInputOptions,
  ) => Promise<ImageInfoResponse>;
  readonly input: (
    image: ImageInputValue,
    options?: ImageInputOptions,
  ) => globalThis.ImageTransformer;
  readonly hosted?: globalThis.HostedImagesBinding;
}

export interface ImagesClient {
  readonly info: (
    image: ImageInputValue,
    options?: ImageInputOptions,
  ) => Effect.Effect<ImageInfoResponse, ImagesOperationError>;
  readonly input: (
    image: ImageInputValue,
    options?: ImageInputOptions,
  ) => Effect.Effect<globalThis.ImageTransformer, ImagesOperationError>;
  readonly process: (
    steps: Steps,
    options: ProcessOptions,
  ) => Effect.Effect<ImagesTransformationResultClient, ImagesOperationError>;
  readonly hosted: Option.Option<HostedImagesClient>;
  readonly unsafeRaw: Effect.Effect<ImagesRuntimeBinding>;
  readonly definition: ImagesDefinition;
}

declare const ImagesServiceTypeId: unique symbol;

/** Nominal service marker for Images services created with {@link make}. */
export interface ImagesService<Id extends string> {
  readonly [ImagesServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  ImagesClient
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

const makeSteps = (steps: ReadonlyArray<Step>): Steps => ({
  [TypeId]: TypeId,
  steps,
});

/** Empty Images transformation pipeline. */
export const empty: Steps = makeSteps([]);

export function transform(transform: ImageTransform): (steps: Steps) => Steps;
export function transform(steps: Steps, transform: ImageTransform): Steps;
export function transform(
  stepsOrTransform: Steps | ImageTransform,
  transformValue?: ImageTransform,
): Steps | ((steps: Steps) => Steps) {
  if (transformValue === undefined) {
    return (steps) => transform(steps, stepsOrTransform as ImageTransform);
  }

  const steps = stepsOrTransform as Steps;

  return makeSteps([
    ...steps.steps,
    {
      _tag: "Transform",
      transform: transformValue,
    },
  ]);
}

export function draw(draw: DrawStepOptions): (steps: Steps) => Steps;
export function draw(steps: Steps, draw: DrawStepOptions): Steps;
export function draw(
  stepsOrDraw: Steps | DrawStepOptions,
  drawValue?: DrawStepOptions,
): Steps | ((steps: Steps) => Steps) {
  if (drawValue === undefined) {
    return (steps) => draw(steps, stepsOrDraw as DrawStepOptions);
  }

  const steps = stepsOrDraw as Steps;

  return makeSteps([
    ...steps.steps,
    {
      _tag: "Draw",
      ...drawValue,
    },
  ]);
}

const imagesError = (binding: string, operation: string, cause: unknown) =>
  new ImagesOperationError({ binding, operation, cause });

const tryImagesPromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, ImagesOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => imagesError(binding, operation, cause),
  });

const tryImagesSync = <A>(
  binding: string,
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, ImagesOperationError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => imagesError(binding, operation, cause),
  });

const maybe = <A>(value: A | null): Option.Option<A> =>
  value === null ? Option.none() : Option.some(value);

const hasFunction = (value: object, key: string): boolean =>
  typeof Reflect.get(value, key) === "function";

const isHostedImagesBinding = (value: unknown): value is globalThis.HostedImagesBinding =>
  typeof value === "object" &&
  value !== null &&
  hasFunction(value, "image") &&
  hasFunction(value, "upload") &&
  hasFunction(value, "list");

export const isImagesBinding = (value: unknown): value is ImagesRuntimeBinding =>
  typeof value === "object" &&
  value !== null &&
  hasFunction(value, "info") &&
  hasFunction(value, "input");

const wrapResult = (
  binding: string,
  result: globalThis.ImageTransformationResult,
): ImagesTransformationResultClient => ({
  raw: result,
  response: tryImagesSync(binding, "response", () => result.response()),
  contentType: tryImagesSync(binding, "contentType", () => result.contentType()),
  image: (options) => tryImagesSync(binding, "image", () => result.image(options)),
});

const wrapHandle = (binding: string, handle: globalThis.ImageHandle): ImageHandleClient => ({
  raw: handle,
  details: tryImagesPromise(binding, "details", () => handle.details()).pipe(Effect.map(maybe)),
  bytes: tryImagesPromise(binding, "bytes", () => handle.bytes()).pipe(Effect.map(maybe)),
  update: (options) => tryImagesPromise(binding, "update", () => handle.update(options)),
  delete: tryImagesPromise(binding, "delete", () => handle.delete()),
});

const wrapHosted = (
  binding: string,
  hosted: globalThis.HostedImagesBinding,
): HostedImagesClient => ({
  image: (imageId) => wrapHandle(binding, hosted.image(imageId)),
  upload: (image, options) =>
    tryImagesPromise(binding, "upload", () => hosted.upload(image, options)),
  list: (options) => tryImagesPromise(binding, "list", () => hosted.list(options)),
  unsafeRaw: Effect.succeed(hosted),
});

export const makeClient =
  (definition: ImagesDefinition) =>
  (images: ImagesRuntimeBinding): ImagesClient => {
    const input = (image: ImageInputValue, options?: ImageInputOptions) =>
      tryImagesSync(definition.binding, "input", () => images.input(image, options));

    const process = (steps: Steps, options: ProcessOptions) =>
      Effect.gen(function* () {
        let transformer = yield* input(options.stream, options.inputOptions);

        for (const step of steps.steps) {
          switch (step._tag) {
            case "Draw": {
              transformer = yield* tryImagesSync(definition.binding, "draw", () =>
                transformer.draw(step.image, step.options),
              );
              break;
            }
            case "Transform": {
              transformer = yield* tryImagesSync(definition.binding, "transform", () =>
                transformer.transform(step.transform),
              );
              break;
            }
          }
        }

        const result = yield* tryImagesPromise(definition.binding, "output", () =>
          transformer.output(options.outputOptions),
        );

        return wrapResult(definition.binding, result);
      });

    return {
      definition,
      info: (image, options) =>
        tryImagesPromise(definition.binding, "info", () => images.info(image, options)),
      input,
      process,
      hosted: isHostedImagesBinding(images.hosted)
        ? Option.some(wrapHosted(definition.binding, images.hosted))
        : Option.none(),
      unsafeRaw: Effect.succeed(images),
    };
  };

export const layer = <Self>(
  tag: Context.Service<Self, ImagesClient>,
  definition: ImagesDefinition,
) =>
  Binding.layer(tag, definition.binding, isImagesBinding, makeClient(definition), {
    expected: expectedImagesBinding,
  });

export const make = <Id extends string>(id: Id) => Tag<ImagesService<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, ImagesClient>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
