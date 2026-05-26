import { Context, Effect, Schema as S, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import type { ExecutionContext, WorkerContext } from "./Worker";
import type * as RpcDefinition from "./RpcDefinition";
import * as WorkflowBinding from "./WorkflowBinding";
import * as WorkflowEntrypoint from "./Workflow";

export interface Definition<
  Id extends string = string,
  Payload extends RpcDefinition.ServiceFreeSchema = RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema = RpcDefinition.ServiceFreeSchema,
> {
  readonly id: Id;
  readonly payload: Payload;
  readonly result: Result;
}

export namespace Definition {
  export type Any = Definition<
    string,
    RpcDefinition.ServiceFreeSchema,
    RpcDefinition.ServiceFreeSchema
  >;
}

export type Handler<ROut, Self extends Definition.Any> = (
  payload: S.Schema.Type<Self["payload"]>,
) => Effect.Effect<
  S.Schema.Type<Self["result"]>,
  unknown,
  WorkflowEntrypoint.WorkflowRunContext<ROut>
>;

export interface Options<ROut, Self extends Definition.Any> {
  readonly run: Handler<ROut, Self>;
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<
  Self,
  Id extends string,
  Payload extends RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema,
> extends Context.ServiceClass<Self, Id, WorkflowBinding.WorkflowBindingClient<Payload, Result>> {
  readonly id: Id;
  readonly payload: Payload;
  readonly result: Result;
  readonly make: <ROut, LayerError>(
    layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
    options: Options<ROut, Definition<Id, Payload, Result>>,
  ) => WorkflowEntrypoint.WorkflowClass<S.Codec.Encoded<Payload>, S.Codec.Encoded<Result>, ROut>;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >;
  readonly create: (
    payload: S.Schema.Type<Payload>,
    options?: WorkflowBinding.WorkflowInstanceCreateOptions<S.Codec.Encoded<Payload>>,
  ) => Effect.Effect<
    WorkflowBinding.WorkflowInstance<S.Schema.Type<Result>>,
    WorkflowBinding.WorkflowOperationError | S.SchemaError,
    Self
  >;
  readonly createBatch: (
    batch: WorkflowBinding.WorkflowInstanceCreateBatchOptions<
      S.Schema.Type<Payload>,
      S.Codec.Encoded<Payload>
    >,
  ) => Effect.Effect<
    ReadonlyArray<WorkflowBinding.WorkflowInstance<S.Schema.Type<Result>>>,
    WorkflowBinding.WorkflowOperationError | S.SchemaError,
    Self
  >;
  readonly get: (
    instanceId: string,
  ) => Effect.Effect<
    WorkflowBinding.WorkflowInstance<S.Schema.Type<Result>>,
    WorkflowBinding.WorkflowOperationError,
    Self
  >;
  readonly unsafeRaw: () => Effect.Effect<
    globalThis.Workflow<S.Codec.Encoded<Payload>>,
    never,
    Self
  >;
}

const makeDefinition = <
  Id extends string,
  Payload extends RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema,
>(
  id: Id,
  definition: {
    readonly payload: Payload;
    readonly result: Result;
  },
) => {
  type SelfDefinition = Definition<Id, Payload, Result>;
  const workflowDefinition: SelfDefinition = {
    id,
    payload: definition.payload,
    result: definition.result,
  };

  return Object.assign(workflowDefinition, {
    make: <ROut, LayerError>(
      layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
      options: Options<ROut, SelfDefinition>,
    ) =>
      WorkflowEntrypoint.make(layer, {
        run: wrapHandler(workflowDefinition, options.run),
      }),
  });
};

export const make = <
  Id extends string,
  Payload extends RpcDefinition.ServiceFreeSchema,
  Result extends RpcDefinition.ServiceFreeSchema,
>(
  id: Id,
  definition: {
    readonly payload: Payload;
    readonly result: Result;
  },
) => Tag<Definition<Id, Payload, Result>>()(id, definition);

export const Tag =
  <Self>() =>
  <
    Id extends string,
    Payload extends RpcDefinition.ServiceFreeSchema,
    Result extends RpcDefinition.ServiceFreeSchema,
  >(
    id: Id,
    definition: {
      readonly payload: Payload;
      readonly result: Result;
    },
  ) => {
    const workflowDefinition = makeDefinition(id, definition);
    const tag = Context.Service<Self, WorkflowBinding.WorkflowBindingClient<Payload, Result>>()(id);

    const layer = (binding: LayerOptions) =>
      WorkflowBinding.layer(tag, {
        ...binding,
        payload: definition.payload,
        result: definition.result,
      });

    const create = Effect.fnUntraced(function* (
      payload: S.Schema.Type<Payload>,
      options?: WorkflowBinding.WorkflowInstanceCreateOptions<S.Codec.Encoded<Payload>>,
    ) {
      const workflow = yield* tag;
      return yield* workflow.create(payload, options);
    });

    const createBatch = Effect.fnUntraced(function* (
      batch: WorkflowBinding.WorkflowInstanceCreateBatchOptions<
        S.Schema.Type<Payload>,
        S.Codec.Encoded<Payload>
      >,
    ) {
      const workflow = yield* tag;
      return yield* workflow.createBatch(batch);
    });

    const get = Effect.fnUntraced(function* (instanceId: string) {
      const workflow = yield* tag;
      return yield* workflow.get(instanceId);
    });

    const unsafeRaw = Effect.fnUntraced(function* () {
      const workflow = yield* tag;
      return yield* workflow.unsafeRaw;
    });

    return Object.assign(tag, {
      id: workflowDefinition.id,
      payload: workflowDefinition.payload,
      result: workflowDefinition.result,
      make: workflowDefinition.make,
      layer,
      create,
      createBatch,
      get,
      unsafeRaw,
    }) as TagClass<Self, Id, Payload, Result>;
  };

export const Workflow = Tag;

const wrapHandler = <ROut, const Self extends Definition.Any>(
  definition: Self,
  handler: Handler<ROut, Self>,
): WorkflowEntrypoint.WorkflowHandler<
  ROut,
  S.Codec.Encoded<Self["payload"]>,
  S.Codec.Encoded<Self["result"]>
> => {
  const decodePayload = S.decodeUnknownEffect(definition.payload);
  const encodeResult = S.encodeEffect(definition.result);

  return (payload) =>
    Effect.gen(function* () {
      const decodedPayload = yield* decodePayload(payload);
      const event = yield* WorkflowEntrypoint.WorkflowEvent;
      const decodedEvent = {
        ...event,
        payload: decodedPayload,
      } as WorkflowEntrypoint.WorkflowEventService<S.Schema.Type<Self["payload"]>>;
      const result = yield* handler(decodedPayload as S.Schema.Type<Self["payload"]>).pipe(
        Effect.provideService(WorkflowEntrypoint.WorkflowEvent, decodedEvent),
      );
      return yield* encodeResult(result as S.Schema.Type<Self["result"]>);
    });
};

export const implement = <ROut, const Self extends Definition.Any>(
  _definition: Self,
  handler: Handler<ROut, Self>,
): Handler<ROut, Self> => handler;
