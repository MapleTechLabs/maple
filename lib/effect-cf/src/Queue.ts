import { Data, Effect, type Scope } from "effect";

import type { ExecutionContext, WorkerContext } from "./Worker";
import type { WorkerEnvironment } from "./Environment";
import * as QueueDefinition from "./QueueDefinition";

export interface QueueMessage<Body> {
  readonly raw: globalThis.Message<unknown>;
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  readonly attempts: number;
  readonly ack: Effect.Effect<void>;
  readonly retry: (options?: globalThis.QueueRetryOptions) => Effect.Effect<void>;
}

export interface QueueBatch<Body> {
  readonly raw: globalThis.MessageBatch<unknown>;
  readonly messages: ReadonlyArray<QueueMessage<Body>>;
  readonly queue: string;
  readonly metadata: globalThis.MessageBatchMetadata;
  readonly ackAll: Effect.Effect<void>;
  readonly retryAll: (options?: globalThis.QueueRetryOptions) => Effect.Effect<void>;
}

export class QueueMessageDecodeError extends Data.TaggedError("QueueMessageDecodeError")<{
  readonly queue: string;
  readonly messageId: string;
  readonly index: number;
  readonly cause: unknown;
}> {}

type RuntimeContext<ROut> = ExecutionContext | WorkerContext | WorkerEnvironment | ROut;

type QueueHandlerContext<ROut> = RuntimeContext<ROut> | Scope.Scope;

export type QueueHandler<ROut, Body = unknown> = (
  batch: QueueBatch<Body>,
) => Effect.Effect<void, unknown, QueueHandlerContext<ROut>>;

export interface QueueOptions<ROut, Body = unknown> {
  readonly queue: QueueHandler<ROut, Body>;
}

export const fromMessage = <Body>(message: globalThis.Message<unknown>, body: Body) => ({
  raw: message,
  id: message.id,
  timestamp: message.timestamp,
  body,
  attempts: message.attempts,
  ack: Effect.sync(() => message.ack()),
  retry: (options?: globalThis.QueueRetryOptions) => Effect.sync(() => message.retry(options)),
});

export const fromMessageBatch = <Body>(
  batch: globalThis.MessageBatch<unknown>,
  messages: ReadonlyArray<QueueMessage<Body>>,
): QueueBatch<Body> => ({
  raw: batch,
  messages,
  queue: batch.queue,
  metadata: batch.metadata,
  ackAll: Effect.sync(() => batch.ackAll()),
  retryAll: (options?: globalThis.QueueRetryOptions) => Effect.sync(() => batch.retryAll(options)),
});

export const decodeBatch = <Body>(
  batch: globalThis.MessageBatch<unknown>,
  decodeBody: (body: unknown) => Effect.Effect<Body, unknown>,
): Effect.Effect<QueueBatch<Body>, QueueMessageDecodeError> =>
  Effect.gen(function* () {
    const messages: Array<QueueMessage<Body>> = [];

    for (let index = 0; index < batch.messages.length; index++) {
      const message = batch.messages[index];
      const body = yield* decodeBody(message.body).pipe(
        Effect.mapError(
          (cause) =>
            new QueueMessageDecodeError({
              queue: batch.queue,
              messageId: message.id,
              index,
              cause,
            }),
        ),
      );

      messages.push(fromMessage(message, body));
    }

    return fromMessageBatch(batch, messages);
  });

export type Definition<
  Id extends string = string,
  Message extends QueueDefinition.Definition.Any["message"] =
    QueueDefinition.Definition.Any["message"],
> = QueueDefinition.Definition<Id, Message>;

export namespace Definition {
  export type Any = QueueDefinition.Definition.Any;
}

export type LayerOptions = QueueDefinition.LayerOptions;

export type TagClass<
  Self,
  Id extends string,
  Message extends QueueDefinition.Definition.Any["message"],
> = QueueDefinition.TagClass<Self, Id, Message>;

export const Tag: <Self>() => <
  Id extends string,
  Message extends QueueDefinition.Definition.Any["message"],
>(
  id: Id,
  definition: { readonly message: Message },
) => TagClass<Self, Id, Message> = QueueDefinition.Tag;

export const implement = QueueDefinition.implement;

export type Handler<ROut, Self extends QueueDefinition.Definition.Any> = QueueDefinition.Handler<
  ROut,
  Self
>;

export type Options<ROut, Self extends QueueDefinition.Definition.Any> = QueueDefinition.Options<
  ROut,
  Self
>;
