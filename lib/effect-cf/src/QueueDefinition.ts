import { Context, Effect, Schema as S, type Layer, type Scope } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import * as QueueEntrypoint from "./Queue";
import * as QueueBinding from "./QueueBinding";
import type { ExecutionContext, WorkerContext } from "./Worker";
import * as WorkerEntrypoint from "./Worker";
import type * as RpcDefinition from "./RpcDefinition";

export interface Definition<
  Id extends string = string,
  Message extends RpcDefinition.ServiceFreeSchema = RpcDefinition.ServiceFreeSchema,
> {
  readonly id: Id;
  readonly message: Message;
}

export namespace Definition {
  export type Any = Definition<string, RpcDefinition.ServiceFreeSchema>;
}

export type Handler<ROut, Self extends Definition.Any> = (
  batch: QueueEntrypoint.QueueBatch<S.Schema.Type<Self["message"]>>,
) => Effect.Effect<
  void,
  unknown,
  ExecutionContext | WorkerEntrypoint.WorkerContext | WorkerEnvironment | Scope.Scope | ROut
>;

export interface Options<ROut, Self extends Definition.Any> extends Omit<
  WorkerEntrypoint.WorkerOptions<ROut, Record<never, never>>,
  "queue" | "rpc"
> {
  readonly queue: Handler<ROut, Self>;
  readonly rpc?: never;
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<
  Self,
  Id extends string,
  Message extends RpcDefinition.ServiceFreeSchema,
> extends Context.ServiceClass<Self, Id, QueueBinding.QueueBindingClient<Message>> {
  readonly id: Id;
  readonly message: Message;
  readonly make: <ROut, LayerError>(
    layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
    options: Options<ROut, Definition<Id, Message>>,
  ) => WorkerEntrypoint.WorkerClass<Record<never, never>, ROut>;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >;
  readonly send: (
    message: S.Schema.Type<Message>,
    options?: QueueBinding.QueueSendOptions,
  ) => Effect.Effect<void, QueueBinding.QueueOperationError | S.SchemaError, Self>;
  readonly sendBatch: (
    messages: Iterable<QueueBinding.MessageSendRequest<S.Schema.Type<Message>>>,
    options?: QueueBinding.QueueSendBatchOptions,
  ) => Effect.Effect<void, QueueBinding.QueueOperationError | S.SchemaError, Self>;
  readonly metrics: () => Effect.Effect<
    QueueBinding.QueueMetrics,
    QueueBinding.QueueOperationError,
    Self
  >;
  readonly unsafeRaw: () => Effect.Effect<globalThis.Queue<S.Codec.Encoded<Message>>, never, Self>;
}

const makeDefinition = <Id extends string, Message extends RpcDefinition.ServiceFreeSchema>(
  id: Id,
  definition: { readonly message: Message },
) => {
  type SelfDefinition = Definition<Id, Message>;
  const queueDefinition: SelfDefinition = {
    id,
    message: definition.message,
  };

  return Object.assign(queueDefinition, {
    make: <ROut, LayerError>(
      layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
      options: Options<ROut, SelfDefinition>,
    ) =>
      WorkerEntrypoint.make(layer, {
        ...options,
        queue: wrapHandler(queueDefinition, options.queue),
      }),
  });
};

export const make = <Id extends string, Message extends RpcDefinition.ServiceFreeSchema>(
  id: Id,
  definition: { readonly message: Message },
) => Tag<Definition<Id, Message>>()(id, definition);

export const Tag =
  <Self>() =>
  <Id extends string, Message extends RpcDefinition.ServiceFreeSchema>(
    id: Id,
    definition: { readonly message: Message },
  ) => {
    const queueDefinition = makeDefinition(id, definition);
    const tag = Context.Service<Self, QueueBinding.QueueBindingClient<Message>>()(id);

    const layer = (binding: LayerOptions) =>
      QueueBinding.layer(tag, {
        ...binding,
        message: definition.message,
      });

    const send = Effect.fnUntraced(function* (
      message: S.Schema.Type<Message>,
      options?: QueueBinding.QueueSendOptions,
    ) {
      const queue = yield* tag;
      yield* queue.send(message, options);
    });

    const sendBatch = Effect.fnUntraced(function* (
      messages: Iterable<QueueBinding.MessageSendRequest<S.Schema.Type<Message>>>,
      options?: QueueBinding.QueueSendBatchOptions,
    ) {
      const queue = yield* tag;
      yield* queue.sendBatch(messages, options);
    });

    const metrics = Effect.fnUntraced(function* () {
      const queue = yield* tag;
      return yield* queue.metrics();
    });

    const unsafeRaw = Effect.fnUntraced(function* () {
      const queue = yield* tag;
      return yield* queue.unsafeRaw;
    });

    return Object.assign(tag, {
      id: queueDefinition.id,
      message: queueDefinition.message,
      make: queueDefinition.make,
      layer,
      send,
      sendBatch,
      metrics,
      unsafeRaw,
    }) as TagClass<Self, Id, Message>;
  };

export const Queue = Tag;

const wrapHandler = <ROut, const Self extends Definition.Any>(
  definition: Self,
  handler: Handler<ROut, Self>,
): QueueEntrypoint.QueueHandler<ROut> => {
  const decodeBody = S.decodeUnknownEffect(definition.message);

  return (batch) =>
    Effect.gen(function* () {
      const decoded = yield* QueueEntrypoint.decodeBatch(batch.raw, decodeBody);
      yield* handler(decoded);
    });
};

export const implement = <ROut, const Self extends Definition.Any>(
  _definition: Self,
  handler: Handler<ROut, Self>,
): Handler<ROut, Self> => handler;
