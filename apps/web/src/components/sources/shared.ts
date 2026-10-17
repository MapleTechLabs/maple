import type { SourceAttributeMode, SourceId, SourceSignal } from "@maple/domain/primitives"
import { SourcePublicId, type V2Source } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { sourcesListAtom } from "@/lib/services/atoms/sources-atoms"

export const SIGNALS: ReadonlyArray<{ value: SourceSignal; label: string; hint: string }> = [
	{ value: "traces", label: "Traces", hint: "/v1/traces" },
	{ value: "logs", label: "Logs", hint: "/v1/logs" },
	{ value: "metrics", label: "Metrics", hint: "/v1/metrics" },
	{ value: "sessions", label: "Sessions", hint: "Replays and session events" },
	{ value: "events", label: "Events", hint: "Product events and track()" },
]

export const MODE_LABELS = {
	set: "Always",
	default: "If missing",
} satisfies Record<SourceAttributeMode, string>

export const signalsSummary = (signals: V2Source["allowed_signals"]) =>
	signals === null
		? "All signals"
		: SIGNALS.filter((signal) => signals.includes(signal.value))
				.map((signal) => signal.label)
				.join(", ")

export const rateLimitLabel = (rps: number | null) => (rps === null ? "No limit" : `${rps} req/s`)

// The API decodes `src_` ids into raw UUIDs; URLs use the public form.
export const toPublicSourceId = Schema.encodeSync(SourcePublicId)
export const fromPublicSourceId = Schema.decodeUnknownOption(SourcePublicId)

/** The one-time token from a create or roll, held in memory until the page is left. */
export interface RevealedToken {
	readonly sourceId: SourceId
	readonly secret: string
	readonly rolled: boolean
}

/** "Paused until Oct 17, 15:42", or "Paused until resumed". */
export const pausedLabel = (source: V2Source) =>
	source.paused_until === null
		? "Paused until resumed"
		: `Paused until ${new Date(source.paused_until).toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			})}`

export type SourceLookup =
	| { readonly _tag: "loading" }
	| { readonly _tag: "failed"; readonly cause: unknown }
	| { readonly _tag: "missing" }
	| { readonly _tag: "found"; readonly source: V2Source }

/** One source from the shared list, which every source page reads. */
export function useSource(sourceId: SourceId): SourceLookup {
	const listResult = useAtomValue(sourcesListAtom)
	if (Result.isInitial(listResult)) return { _tag: "loading" }
	if (!Result.isSuccess(listResult)) return { _tag: "failed", cause: listResult.cause }
	const source = listResult.value.data.find((candidate) => candidate.id === sourceId)
	return source === undefined ? { _tag: "missing" } : { _tag: "found", source }
}

/** Token sources take rules and actions; the default source and integrations have no token. */
export const hasToken = (source: V2Source) => source.key_prefix !== null
