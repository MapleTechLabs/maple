import type { CustomIngestKeyId, IngestKeyAttributeMode, IngestKeySignal } from "@maple/domain/http"
import { CustomIngestKeyPublicId, type V2CustomIngestKey } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { customIngestKeysListAtom } from "@/lib/services/atoms/ingestion-atoms"

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
export const fromPublicKeyId = Schema.decodeUnknownOption(CustomIngestKeyPublicId)

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

export type CustomIngestKeyLookup =
	| { readonly _tag: "loading" }
	| { readonly _tag: "failed" }
	| { readonly _tag: "missing" }
	| { readonly _tag: "found"; readonly key: V2CustomIngestKey }

/** One key from the shared list, which every key page reads. */
export function useCustomIngestKey(keyId: CustomIngestKeyId): CustomIngestKeyLookup {
	const listResult = useAtomValue(customIngestKeysListAtom)
	if (Result.isInitial(listResult)) return { _tag: "loading" }
	if (!Result.isSuccess(listResult)) return { _tag: "failed" }
	const key = listResult.value.data.find((candidate) => candidate.id === keyId)
	return key === undefined ? { _tag: "missing" } : { _tag: "found", key }
}
