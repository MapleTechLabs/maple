import { Data, Effect, Option, Schema as S } from "effect";

import { DurableObjectState } from "./DurableObjectState";

/** Data supported by Cloudflare websocket `send`. */
export type DurableWebSocketSendData = string | ArrayBuffer | ArrayBufferView;

/** Error raised when sending on a Durable Object websocket fails. */
export class DurableWebSocketSendError extends Data.TaggedError("DurableWebSocketSendError")<{
  readonly cause: unknown;
}> {}

/** Error raised when closing a Durable Object websocket fails. */
export class DurableWebSocketCloseError extends Data.TaggedError("DurableWebSocketCloseError")<{
  readonly cause: unknown;
}> {}

/** Error raised when serializing or deserializing a websocket attachment fails. */
export class DurableWebSocketAttachmentError extends Data.TaggedError(
  "DurableWebSocketAttachmentError",
)<{
  readonly operation: "serialize" | "deserialize";
  readonly cause: unknown;
}> {}

/** Effect-native wrapper around a hibernatable Durable Object websocket. */
export interface DurableWebSocket<Attachment = unknown> {
  /** Underlying Cloudflare websocket. */
  readonly raw: WebSocket;
  /** Sends a message through the socket. */
  send(data: DurableWebSocketSendData): Effect.Effect<void, DurableWebSocketSendError>;
  /** Closes the socket. */
  close(code?: number, reason?: string): Effect.Effect<void, DurableWebSocketCloseError>;
  /** Serializes hibernation attachment metadata onto the socket. */
  serializeAttachment<A = Attachment>(
    value: A,
  ): Effect.Effect<void, DurableWebSocketAttachmentError>;
  /** Deserializes hibernation attachment metadata from the socket. */
  readonly deserializeAttachment: Effect.Effect<unknown, DurableWebSocketAttachmentError>;
}

const wrappers = new WeakMap<WebSocket, DurableWebSocket<unknown>>();

/** Wraps a native Cloudflare websocket in the Effect-native Durable Object API. */
export const fromWebSocket = <Attachment = unknown>(
  raw: WebSocket,
): DurableWebSocket<Attachment> => {
  const existing = wrappers.get(raw);
  if (existing !== undefined) {
    return existing as DurableWebSocket<Attachment>;
  }

  const socket: DurableWebSocket<unknown> = {
    raw,
    send: (data) =>
      Effect.try({
        try: () => raw.send(data),
        catch: (cause) => new DurableWebSocketSendError({ cause }),
      }),
    close: (code, reason) =>
      Effect.try({
        try: () => raw.close(code, reason),
        catch: (cause) => new DurableWebSocketCloseError({ cause }),
      }),
    serializeAttachment: (value) =>
      Effect.try({
        try: () => raw.serializeAttachment(value),
        catch: (cause) => new DurableWebSocketAttachmentError({ operation: "serialize", cause }),
      }),
    deserializeAttachment: Effect.try({
      try: () => raw.deserializeAttachment(),
      catch: (cause) => new DurableWebSocketAttachmentError({ operation: "deserialize", cause }),
    }),
  };

  wrappers.set(raw, socket);
  return socket as DurableWebSocket<Attachment>;
};

/**
 * Options for accepting an incoming websocket request in a Durable Object.
 */
export interface AcceptUpgradeOptions<Attachment = unknown> {
  /** Optional websocket tags for Durable Object hibernation filtering. */
  readonly tags?: ReadonlyArray<string> | undefined;
  /** Optional attachment serialized onto the server socket. */
  readonly attachment?: Attachment | undefined;
}

/**
 * Result of a websocket upgrade accepted by {@link acceptUpgrade}.
 */
export interface AcceptedUpgrade<Attachment = unknown> {
  readonly client: WebSocket;
  readonly server: DurableWebSocket<Attachment>;
  readonly response: Response;
}

/**
 * Accepts a websocket upgrade and registers the server socket on `DurableObjectState`.
 *
 * @example
 * ```ts
 * const response = yield* DurableObjectWebSocket.acceptUpgrade({
 *   tags: ["room:general"],
 * });
 *
 * return response.response;
 * ```
 */
export const acceptUpgrade = <Attachment = unknown>(
  options: AcceptUpgradeOptions<Attachment> = {},
): Effect.Effect<AcceptedUpgrade<Attachment>, never, DurableObjectState> =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = fromWebSocket<Attachment>(pair[1]);

    if (options.attachment !== undefined) {
      server.raw.serializeAttachment(options.attachment);
    }

    yield* state.acceptWebSocket(
      server,
      options.tags === undefined ? undefined : [...options.tags],
    );

    return {
      client,
      server,
      response: new Response(null, {
        status: 101,
        webSocket: client,
      }),
    };
  });

export type AttachmentInvalidPolicy = "ignore" | "ignore-and-close" | "fail";

export interface AttachmentRehydrateOptions {
  /** Optional Durable Object websocket tag filter. */
  readonly tag?: string | undefined;
  /** Invalid attachment behavior. Defaults to skipping invalid sockets. */
  readonly onInvalid?: AttachmentInvalidPolicy | undefined;
}

export interface RehydratedDurableWebSocket<Attachment> {
  readonly socket: DurableWebSocket<Attachment>;
  readonly attachment: Attachment;
}

export interface DurableWebSocketAttachment<Attachment, Encoded> {
  serialize(
    socket: DurableWebSocket<unknown>,
    value: Attachment,
  ): Effect.Effect<void, DurableWebSocketAttachmentError>;
  deserialize(
    socket: DurableWebSocket<unknown>,
  ): Effect.Effect<Option.Option<Attachment>, DurableWebSocketAttachmentError>;
  rehydrate(
    options?: AttachmentRehydrateOptions,
  ): Effect.Effect<
    Array<RehydratedDurableWebSocket<Attachment>>,
    DurableWebSocketAttachmentError,
    DurableObjectState
  >;
  readonly schema: S.Codec<Attachment, Encoded, never, never>;
}

/** Creates typed attachment helpers for accepted and rehydrated sockets. */
export const attachment = <const AttachmentSchema extends S.Codec<any, any, never, never>>(
  schema: AttachmentSchema,
): DurableWebSocketAttachment<
  S.Schema.Type<AttachmentSchema>,
  S.Codec.Encoded<AttachmentSchema>
> => {
  type Attachment = S.Schema.Type<AttachmentSchema>;
  type Encoded = S.Codec.Encoded<AttachmentSchema>;

  const serialize = (socket: DurableWebSocket<unknown>, value: Attachment) =>
    S.encodeEffect(schema)(value).pipe(
      Effect.mapError(
        (cause) => new DurableWebSocketAttachmentError({ operation: "serialize", cause }),
      ),
      Effect.flatMap((encoded) => socket.serializeAttachment(encoded as Encoded)),
    );

  const deserialize = (socket: DurableWebSocket<unknown>) =>
    Effect.gen(function* () {
      const value = yield* socket.deserializeAttachment;
      if (value == null) {
        return Option.none<Attachment>();
      }

      return Option.some(
        yield* S.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError(
            (cause) => new DurableWebSocketAttachmentError({ operation: "deserialize", cause }),
          ),
        ),
      );
    });

  const rehydrate = (options: AttachmentRehydrateOptions = {}) =>
    Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const sockets = yield* state.getWebSockets(options.tag);
      const restored: Array<RehydratedDurableWebSocket<Attachment>> = [];
      const onInvalid = options.onInvalid ?? "ignore";

      for (const socket of sockets) {
        const decoded = yield* deserialize(socket).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: "Failure" as const, error }),
            onSuccess: (value) => ({ _tag: "Success" as const, value }),
          }),
        );

        if (decoded._tag === "Success" && Option.isSome(decoded.value)) {
          restored.push({ socket, attachment: decoded.value.value });
          continue;
        }

        if (decoded._tag === "Failure" && onInvalid === "fail") {
          return yield* Effect.fail(decoded.error);
        }

        if (decoded._tag === "Failure" && onInvalid === "ignore-and-close") {
          yield* socket.close(1008, "invalid websocket attachment").pipe(Effect.ignore);
        }
      }

      return restored;
    });

  return { serialize, deserialize, rehydrate, schema };
};

export interface DurableWebSocketHandlers<R = never, E = unknown> {
  readonly message?: (
    socket: DurableWebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void, E, R>;
  readonly close?: (
    socket: DurableWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void, E, R>;
  readonly error?: (socket: DurableWebSocket, error: unknown) => Effect.Effect<void, E, R>;
}

/** Maps compact websocket lifecycle handler names to `DurableObject.make` options. */
export const handlers = <R = never, E = unknown>(options: DurableWebSocketHandlers<R, E>) => ({
  webSocketMessage: options.message,
  webSocketClose: options.close,
  webSocketError: options.error,
});
