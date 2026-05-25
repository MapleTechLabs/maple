import { Cause, Context, Effect, Exit } from "effect";

import { fromDurableObjectStorage, type DurableObjectStorage } from "./DurableObjectStorage";
import { fromWebSocket, type DurableWebSocket } from "./DurableObjectWebSocket";

/**
 * Effect-friendly wrapper around Cloudflare `DurableObjectState`.
 */
export interface DurableObjectStateService {
  /** Underlying Cloudflare state instance. */
  readonly raw: globalThis.DurableObjectState;
  /** Durable Object id for the current instance. */
  readonly id: globalThis.DurableObjectId;
  /** Wrapped storage API. */
  readonly storage: DurableObjectStorage;
  /** Registers background work with Cloudflare's lifecycle. */
  waitUntil(promise: Promise<unknown>): Effect.Effect<void>;
  /**
   * Runs an Effect inside Cloudflare's `blockConcurrencyWhile` gate.
   *
   * Cloudflare resets a Durable Object if the callback throws/rejects, or if the
   * callback exceeds the platform timeout (currently documented as 30 seconds).
   * This safe default resolves the callback with the Effect `Exit` for typed
   * Effect failures and resumes that `Exit` afterward, so typed failures remain
   * ordinary Effect failures instead of resetting the Durable Object. Defects
   * and interruptions still reject the callback.
   */
  blockConcurrencyWhile<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  /**
   * Runs an Effect inside Cloudflare's `blockConcurrencyWhile` gate and lets
   * Effect failures reject the callback.
   *
   * Use this only when Cloudflare's reset-on-throw behavior is intentional. The
   * platform also resets the Durable Object if the callback exceeds the
   * documented timeout (currently 30 seconds).
   */
  blockConcurrencyWhileOrReset<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  /** Accepts a websocket connection for hibernation-capable Durable Objects. */
  acceptWebSocket(ws: DurableWebSocket, tags?: Array<string>): Effect.Effect<void>;
  /** Lists active sockets, optionally filtered by tag. */
  getWebSockets(tag?: string): Effect.Effect<Array<DurableWebSocket>>;
  /** Configures automatic request/response handling for sockets. */
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): Effect.Effect<void>;
  /** Gets the configured websocket auto-response pair. */
  getWebSocketAutoResponse: Effect.Effect<WebSocketRequestResponsePair | null>;
  /** Timestamp of the last automatic websocket response for a socket. */
  getWebSocketAutoResponseTimestamp(ws: DurableWebSocket): Effect.Effect<Date | null>;
  /** Sets the timeout for hibernatable websocket events. */
  setHibernatableWebSocketEventTimeout(timeoutMs?: number): Effect.Effect<void>;
  /** Gets the timeout for hibernatable websocket events. */
  getHibernatableWebSocketEventTimeout: Effect.Effect<number | null>;
  /** Reads tags attached to a websocket. */
  getTags(ws: DurableWebSocket): Effect.Effect<Array<string>>;
  /**
   * Forcibly resets the Durable Object. Cloudflare logs an uncaught Error using
   * the optional reason, and the method is not available in `wrangler dev` local
   * development according to the Durable Object State docs.
   */
  abort(reason?: string): Effect.Effect<void>;
}

/**
 * Context tag for accessing the current Durable Object state service.
 */
export class DurableObjectState extends Context.Service<
  DurableObjectState,
  DurableObjectStateService
>()("effect-cf/DurableObjectState") {}

/**
 * Wraps a native Cloudflare `DurableObjectState` as a {@link DurableObjectStateService}.
 */
export const fromDurableObjectState = (
  state: globalThis.DurableObjectState,
): DurableObjectStateService => ({
  raw: state,
  id: state.id,
  storage: fromDurableObjectStorage(state.storage),
  waitUntil: (promise: Promise<unknown>) => Effect.sync(() => state.waitUntil(promise)),
  blockConcurrencyWhile: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.context<R>().pipe(
      Effect.flatMap((context) =>
        Effect.promise(() =>
          state.blockConcurrencyWhile(() =>
            runPromiseExitPreservingTypedFailures(Effect.provideContext(effect, context)),
          ),
        ),
      ),
      Effect.flatten,
    ),
  blockConcurrencyWhileOrReset: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.context<R>().pipe(
      Effect.flatMap((context) =>
        Effect.promise(() =>
          state.blockConcurrencyWhile(() =>
            Effect.runPromise(Effect.provideContext(effect, context)),
          ),
        ),
      ),
    ),
  acceptWebSocket: (ws: DurableWebSocket, tags?: Array<string>) =>
    Effect.sync(() => state.acceptWebSocket(ws.raw, tags)),
  getWebSockets: (tag?: string) =>
    Effect.sync(() => state.getWebSockets(tag).map((socket) => fromWebSocket(socket))),
  setWebSocketAutoResponse: (pair?: WebSocketRequestResponsePair) =>
    Effect.sync(() => state.setWebSocketAutoResponse(pair)),
  getWebSocketAutoResponse: Effect.sync(() => state.getWebSocketAutoResponse()),
  getWebSocketAutoResponseTimestamp: (ws: DurableWebSocket) =>
    Effect.sync(() => state.getWebSocketAutoResponseTimestamp(ws.raw)),
  setHibernatableWebSocketEventTimeout: (timeoutMs?: number) =>
    Effect.sync(() => state.setHibernatableWebSocketEventTimeout(timeoutMs)),
  getHibernatableWebSocketEventTimeout: Effect.sync(() =>
    state.getHibernatableWebSocketEventTimeout(),
  ),
  getTags: (ws: DurableWebSocket) => Effect.sync(() => state.getTags(ws.raw)),
  abort: (reason?: string) => Effect.sync(() => state.abort(reason)),
});

const runPromiseExitPreservingTypedFailures = async <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> => {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isFailure(exit) && (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))) {
    throw Cause.squash(exit.cause);
  }

  return exit;
};
