import type { CustomIngestKeyId, IngestKeyAttributeMode, IngestKeySignal } from "@maple/domain/http"
import { CustomIngestKeyPublicId, type V2CustomIngestKey } from "@maple/domain/http/v2"
import { Option, Schema } from "effect"

export const SIGNALS: ReadonlyArray<{ value: IngestKeySignal; label: string; hint: string }> = [
	{ value: "traces", label: "Traces", hint: "/v1/traces" },
	{ value: "logs", label: "Logs", hint: "/v1/logs" },
	{ value: "metrics", label: "Metrics", hint: "/v1/metrics" },
	{ value: "sessions", label: "Sessions", hint: "Replays and session events" },
	{ value: "events", label: "Events", hint: "Product events and track()" },
]

export const MODE_LABELS = {
	set: "Always",
	default: "If missing",
} satisfies Record<IngestKeyAttributeMode, string>

export const signalsSummary = (signals: V2CustomIngestKey["allowed_signals"]) =>
	signals === null
		? "All signals"
		: SIGNALS.filter((signal) => signals.includes(signal.value))
				.map((signal) => signal.label)
				.join(", ")

export const rateLimitLabel = (rps: number | null) => (rps === null ? "No limit" : `${rps} req/s`)

export const attributeCountLabel = (count: number) =>
	count === 0 ? "None" : count === 1 ? "1 attribute" : `${count} attributes`

// The API decodes `ingk_` ids into raw UUIDs; URLs and the gateway's stamp use the public form.
export const toPublicKeyId = Schema.encodeSync(CustomIngestKeyPublicId)
const decodePublicKeyId = Schema.decodeUnknownOption(CustomIngestKeyPublicId)
export const fromPublicKeyId = (value: string): Option.Option<CustomIngestKeyId> => decodePublicKeyId(value)

/** The one-time secret from a create or roll, held in memory until the key page is left. */
export interface RevealedSecret {
	readonly keyId: CustomIngestKeyId
	readonly secret: string
	readonly rolled: boolean
}

const LIVE_WINDOW_MS = 15 * 60 * 1000

export type KeyActivity = "live" | "idle" | "waiting" | "paused" | "expired"

/** Lifecycle from the API's `status`, then recency of `last_used_at` for active keys. */
export const keyActivity = (key: V2CustomIngestKey, now: number): KeyActivity => {
	if (key.status !== "active") return key.status
	if (key.last_used_at === null) return "waiting"
	return now - new Date(key.last_used_at).getTime() <= LIVE_WINDOW_MS ? "live" : "idle"
}

export const ACTIVITY_LABELS = {
	live: "Live",
	idle: "Idle",
	waiting: "Waiting for data",
	paused: "Paused",
	expired: "Expired",
} satisfies Record<KeyActivity, string>

/** "Paused until 15:42", or "Paused until resumed". */
export const pausedLabel = (key: V2CustomIngestKey) =>
	key.paused_until === null
		? "Paused until resumed"
		: `Paused until ${new Date(key.paused_until).toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			})}`
