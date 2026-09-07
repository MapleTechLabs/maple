import { Effect, Option, Schema } from "effect"
import { McpSchema } from "effect/unstable/ai"
import type { KeyValueStore } from "@/platform/bindings"

export type SessionPayload = typeof McpSchema.Initialize.payloadSchema.Type

const SESSION_TTL_SECONDS = 60 * 60 * 24
const decodePayload = Schema.decodeUnknownOption(McpSchema.Initialize.payloadSchema)

// Plain in-memory Map handed to Effect's MCP layer via `clientSessions`. The
// KV copy behind it is driven from the Worker's fetch handler.
export const sessionStore = new Map<string, SessionPayload>()

/** Warm the Map from KV for a session this isolate has not seen. A failed read is logged, never surfaced. */
export const preloadSession = (kv: KeyValueStore, sessionId: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		if (sessionStore.has(sessionId)) return
		const payload = Option.flatMap(yield* kv.getJson(sessionId), decodePayload)
		if (Option.isSome(payload)) sessionStore.set(sessionId, payload.value)
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.logError("[mcp-session-kv] preload failed").pipe(
				Effect.annotateLogs({ sessionId, cause }),
			),
		),
	)

/** Copy a session the server just issued into KV; nothing to do when the Map holds nothing for it. */
export const persistSession = (kv: KeyValueStore, sessionId: string): Effect.Effect<void> => {
	const payload = sessionStore.get(sessionId)
	if (!payload) return Effect.void
	return kv
		.put(sessionId, JSON.stringify(payload), { expirationTtl: SESSION_TTL_SECONDS })
		.pipe(
			Effect.catchCause((cause) =>
				Effect.logError("[mcp-session-kv] put failed").pipe(
					Effect.annotateLogs({ sessionId, cause }),
				),
			),
		)
}
