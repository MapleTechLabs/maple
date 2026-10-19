import { SourcePublicId, type V2Source } from "@maple/domain/http/v2"
import type { SourceAttributeMode, SourceSignal } from "@maple/domain/primitives"
import { Schema } from "effect"
import { AppRoute, hrefOf } from "../../../route"
import type { SourceTab } from "../../../route/search"

// apps/web/src/components/sources/shared.ts and `orderSources` (sources-table.tsx).

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
} as const satisfies Record<SourceAttributeMode, string>

export const signalsSummary = (signals: V2Source["allowed_signals"]): string =>
	signals === null
		? "All signals"
		: SIGNALS.filter((signal) => signals.includes(signal.value))
				.map((signal) => signal.label)
				.join(", ")

export const rateLimitLabel = (rps: number | null): string => (rps === null ? "No limit" : `${rps} req/s`)

// The API decodes `src_` ids into raw UUIDs; URLs use the public form.
export const toPublicSourceId = Schema.encodeSync(SourcePublicId)
export const fromPublicSourceId = Schema.decodeUnknownOption(SourcePublicId)

/** "Paused until Oct 17, 15:42", or "Paused until resumed". */
export const pausedLabel = (source: V2Source): string =>
	source.paused_until === null
		? "Paused until resumed"
		: `Paused until ${new Date(source.paused_until).toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			})}`

/** Token sources take rules and actions; the default source and integrations have no token. */
export const hasToken = (source: V2Source): boolean => source.key_prefix !== null

/** Default source first, then the API's order (newest first). */
export const orderSources = (sources: ReadonlyArray<V2Source>): ReadonlyArray<V2Source> => [
	...sources.filter((source) => source.is_default),
	...sources.filter((source) => !source.is_default),
]

/** `/sources/$sourceId` in its public id form; the overview tab drops `tab`, as legacy's links do. */
export const sourceHref = (source: V2Source, tab: SourceTab = "overview"): string =>
	hrefOf(
		AppRoute.Source({
			sourceId: toPublicSourceId(source.id),
			search: tab === "overview" ? {} : { tab },
		}),
	)
