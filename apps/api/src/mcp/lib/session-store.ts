// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import { Effect, Option } from "effect"
import type { McpSchema } from "effect/unstable/ai"
import type { KeyValueStore } from "@/platform/bindings"

export type SessionPayload = typeof McpSchema.Initialize.payloadSchema.Type

const SESSION_TTL_SECONDS = 60 * 60 * 24

// Plain in-memory Map handed to Effect's MCP layer via `clientSessions`. The
// KV copy behind it is driven from the Worker's fetch handler — see the note
// there for why we don't do them inside an override on this Map.
export const sessionStore = new Map<string, SessionPayload>()

/** Warm the Map from KV for a session this isolate has not seen. A failed read is logged, never surfaced. */
export const preloadSession = (kv: KeyValueStore, sessionId: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		if (sessionStore.has(sessionId)) return
		const value = yield* kv.getJson(sessionId)
		if (Option.isSome(value)) sessionStore.set(sessionId, value.value as SessionPayload)
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.logError("[mcp-session-kv] preload failed").pipe(
				Effect.annotateLogs({ sessionId, cause }),
			),
		),
	)

/** Copy a session the server just issued into KV, or `undefined` when the Map holds nothing for it. */
export const persistSession = (kv: KeyValueStore, sessionId: string): Effect.Effect<void> | undefined => {
	const payload = sessionStore.get(sessionId)
	if (!payload) return undefined
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
