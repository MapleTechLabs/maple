import { Context, Data, Effect, Schema as S } from "effect";

import * as Binding from "./Binding";
import type * as RpcDefinition from "./RpcDefinition";

export type QueueSendOptions = globalThis.QueueSendOptions;
export type QueueSendResponse = globalThis.QueueSendResponse;
export type QueueSendBatchOptions = globalThis.QueueSendBatchOptions;
export type QueueSendBatchResponse = globalThis.QueueSendBatchResponse;
export type QueueMetrics = globalThis.QueueMetrics;
export type MessageSendRequest<Body> = globalThis.MessageSendRequest<Body>;

export type QueueProducer<Body> = Pick<globalThis.Queue<Body>, "send"> &
  Partial<Pick<globalThis.Queue<Body>, "sendBatch" | "metrics">>;

const expectedQueueProducer = "Queue producer binding with send(); optional sendBatch()/metrics()";

export interface QueueBindingDefinition<Message extends RpcDefinition.ServiceFreeSchema> {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
  /** Codec used to encode messages before sending them to Cloudflare Queues. */
  readonly message: Message;
}

export interface QueueBindingClient<Message extends RpcDefinition.ServiceFreeSchema> {
  readonly send: (
    message: S.Schema.Type<Message>,
    options?: QueueSendOptions,
  ) => Effect.Effect<void, QueueOperationError | S.SchemaError>;
  readonly sendBatch: (
    messages: Iterable<MessageSendRequest<S.Schema.Type<Message>>>,
    options?: QueueSendBatchOptions,
  ) => Effect.Effect<void, QueueOperationError | S.SchemaError>;
  readonly metrics: () => Effect.Effect<QueueMetrics, QueueOperationError>;
  readonly unsafeRaw: Effect.Effect<globalThis.Queue<S.Codec.Encoded<Message>>>;
}

export class QueueOperationError extends Data.TaggedError("QueueOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

const tryQueuePromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, QueueOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new QueueOperationError({
        binding,
        operation,
        cause,
        message: `Cloudflare queue binding "${binding}" operation "${operation}" failed`,
      }),
  });

export const isQueue = <Body>(value: unknown): value is QueueProducer<Body> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const resource = value as Record<string, unknown>;

  return typeof resource.send === "function";
};

export const makeClient = <Message extends RpcDefinition.ServiceFreeSchema>(
  definition: QueueBindingDefinition<Message>,
): ((queue: QueueProducer<S.Codec.Encoded<Message>>) => QueueBindingClient<Message>) => {
  type Body = S.Schema.Type<Message>;
  type EncodedBody = S.Codec.Encoded<Message>;

  const encodeMessage = S.encodeEffect(definition.message);

  return (queue) => ({
    send: Effect.fnUntraced(function* (message: Body, options?: QueueSendOptions) {
      const encoded = yield* encodeMessage(message);

      yield* tryQueuePromise(definition.binding, "send", () => queue.send(encoded, options));
    }),
    sendBatch: Effect.fnUntraced(function* (
      messages: Iterable<MessageSendRequest<Body>>,
      options?: QueueSendBatchOptions,
    ) {
      const encodedMessages: Array<MessageSendRequest<EncodedBody>> = [];

      for (const message of messages) {
        encodedMessages.push({
          ...message,
          body: yield* encodeMessage(message.body),
        });
      }

      const sendBatch = queue.sendBatch;

      if (sendBatch !== undefined) {
        yield* tryQueuePromise(definition.binding, "sendBatch", () =>
          sendBatch.call(queue, encodedMessages, options),
        );
        return;
      }

      yield* tryQueuePromise(definition.binding, "sendBatch", async () => {
        for (const message of encodedMessages) {
          await queue.send(message.body, {
            contentType: message.contentType,
            delaySeconds: message.delaySeconds ?? options?.delaySeconds,
          });
        }
      });
    }),
    metrics: () => {
      const metrics = queue.metrics;

      if (metrics === undefined) {
        return Effect.fail(
          new QueueOperationError({
            binding: definition.binding,
            operation: "metrics",
            cause: new Error(`Queue binding "${definition.binding}" does not provide metrics()`),
            message: `Cloudflare queue binding "${definition.binding}" does not provide metrics()`,
          }),
        );
      }

      return tryQueuePromise(definition.binding, "metrics", () => metrics.call(queue));
    },
    unsafeRaw: Effect.succeed(queue as globalThis.Queue<EncodedBody>),
  });
};

export const layer = <Self, Message extends RpcDefinition.ServiceFreeSchema>(
  tag: Context.Service<Self, QueueBindingClient<Message>>,
  definition: QueueBindingDefinition<Message>,
) =>
  Binding.layer(
    tag,
    definition.binding,
    (value): value is QueueProducer<S.Codec.Encoded<Message>> =>
      isQueue<S.Codec.Encoded<Message>>(value),
    makeClient(definition),
    { expected: expectedQueueProducer },
  );
