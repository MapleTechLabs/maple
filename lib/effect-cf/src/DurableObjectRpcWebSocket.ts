import { Context, Effect, Layer, Option, Queue } from "effect";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { DurableObjectState } from "./DurableObjectState";
import type { DurableWebSocket } from "./DurableObjectWebSocket";

const defaultAttachmentKey = "effectCloudflareRpcClientId";
const defaultTag = "effect-cf-rpc";

/**
 * Configuration for {@link layer}.
 */
export interface LayerOptions {
  /** Tag used to select hibernated sockets. */
  readonly tag?: string | undefined;
  /** Socket attachment key used to persist client ids across hibernation. */
  readonly attachmentKey?: string | undefined;
}

/** Native websocket event payload accepted by Cloudflare Durable Objects. */
export type NativeWebSocketMessage = string | ArrayBuffer;

/**
 * Service API used to wire websocket lifecycle events to Effect RPC server protocol.
 */
export interface DurableObjectRpcWebSocketService {
  readonly accept: (socket: DurableWebSocket) => Effect.Effect<void>;
  readonly message: (
    socket: DurableWebSocket,
    message: NativeWebSocketMessage,
  ) => Effect.Effect<void>;
  readonly close: (socket: DurableWebSocket) => Effect.Effect<void>;
  readonly error: (socket: DurableWebSocket, error: unknown) => Effect.Effect<void>;
}

interface RpcConnection {
  readonly id: number;
  readonly socket: DurableWebSocket;
  readonly parser: RpcSerialization.Parser;
}

/**
 * Context tag for the Durable Object RPC websocket service.
 */
export class DurableObjectRpcWebSocket extends Context.Service<
  DurableObjectRpcWebSocket,
  DurableObjectRpcWebSocketService
>()("effect-cf/DurableObjectRpcWebSocket") {}

/**
 * Builds a layer that bridges Durable Object websocket events to `RpcServer.Protocol`.
 */
export const layer = (options: LayerOptions = {}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const tag = options.tag ?? defaultTag;
      const attachmentKey = options.attachmentKey ?? defaultAttachmentKey;
      const durableObjectState = yield* DurableObjectState;
      const serialization = yield* RpcSerialization.RpcSerialization;
      const disconnects = yield* Queue.make<number>();
      const connectionsBySocket = new Map<WebSocket, RpcConnection>();
      const connectionsById = new Map<number, RpcConnection>();
      const clientIds = new Set<number>();
      let nextClientId = 0;
      let writeRequest:
        | ((clientId: number, data: RpcMessage.FromClientEncoded) => Effect.Effect<void>)
        | undefined;

      const reserveClientId = (socket: DurableWebSocket) => {
        const attachment = readAttachment(socket.raw, attachmentKey);
        if (attachment !== undefined) {
          nextClientId = Math.max(nextClientId, attachment + 1);
          return attachment;
        }

        const id = nextClientId++;
        writeAttachment(socket.raw, attachmentKey, id);
        return id;
      };

      const register = (socket: DurableWebSocket) => {
        const existing = connectionsBySocket.get(socket.raw);
        if (existing !== undefined) {
          return existing;
        }

        const connection = {
          id: reserveClientId(socket),
          socket,
          parser: serialization.makeUnsafe(),
        } satisfies RpcConnection;

        connectionsBySocket.set(socket.raw, connection);
        connectionsById.set(connection.id, connection);
        clientIds.add(connection.id);
        return connection;
      };

      const unregister = (socket: DurableWebSocket) =>
        Effect.sync(() => {
          const connection = connectionsBySocket.get(socket.raw);
          if (connection === undefined) {
            return;
          }

          connectionsBySocket.delete(socket.raw);
          connectionsById.delete(connection.id);
          clientIds.delete(connection.id);
          Queue.offerUnsafe(disconnects, connection.id);
        });

      for (const socket of yield* durableObjectState.getWebSockets(tag)) {
        register(socket);
      }

      const send = (connection: RpcConnection, response: RpcMessage.FromServerEncoded) =>
        Effect.sync(() => {
          try {
            const encoded = connection.parser.encode(response);
            if (encoded !== undefined) {
              connection.socket.raw.send(encoded);
            }
          } catch (cause) {
            const encoded = connection.parser.encode(RpcMessage.ResponseDefectEncoded(cause));
            if (encoded !== undefined) {
              connection.socket.raw.send(encoded);
            }
          }
        });

      const protocol = yield* RpcServer.Protocol.make((writeRequest_) => {
        writeRequest = writeRequest_;

        return Effect.succeed({
          disconnects,
          send: (clientId, response) => {
            const connection = connectionsById.get(clientId);
            return connection === undefined ? Effect.void : send(connection, response);
          },
          end: (clientId) =>
            Effect.sync(() => {
              const connection = connectionsById.get(clientId);
              connection?.socket.raw.close();
            }),
          clientIds: Effect.sync(() => clientIds),
          initialMessage: Effect.succeed(Option.none()),
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
        });
      });

      const service = DurableObjectRpcWebSocket.of({
        accept: (socket) =>
          Effect.gen(function* () {
            register(socket);
            yield* durableObjectState.acceptWebSocket(socket, [tag]);
          }),
        message: (socket, message) =>
          Effect.gen(function* () {
            const connection = register(socket);
            const decoded = yield* Effect.try({
              try: () => connection.parser.decode(normalizeMessage(message)),
              catch: RpcMessage.ResponseDefectEncoded,
            });

            const run = writeRequest;
            if (run === undefined) {
              yield* send(connection, RpcMessage.ResponseDefectEncoded("RPC server is not ready"));
              return;
            }

            for (const current of decoded) {
              yield* run(connection.id, current as RpcMessage.FromClientEncoded);
            }
          }).pipe(
            Effect.catch((error) => {
              const connection = register(socket);
              return send(connection, error);
            }),
          ),
        close: unregister,
        error: (socket, error) =>
          Effect.gen(function* () {
            yield* Effect.logDebug("Durable Object RPC websocket error", error);
            yield* unregister(socket);
          }),
      });

      return Context.mergeAll(
        Context.make(RpcServer.Protocol, protocol),
        Context.make(DurableObjectRpcWebSocket, service),
      );
    }),
  );

const normalizeMessage = (message: NativeWebSocketMessage) =>
  typeof message === "string" ? message : new Uint8Array(message);

const readAttachment = (socket: WebSocket, key: string): number | undefined => {
  const value = socket.deserializeAttachment();

  if (
    value !== null &&
    typeof value === "object" &&
    key in value &&
    typeof value[key] === "number"
  ) {
    return value[key];
  }

  return undefined;
};

const writeAttachment = (socket: WebSocket, key: string, clientId: number) => {
  const current = socket.deserializeAttachment();
  const attachment =
    current !== null && typeof current === "object" && !Array.isArray(current) ? current : {};

  socket.serializeAttachment({
    ...attachment,
    [key]: clientId,
  });
};
