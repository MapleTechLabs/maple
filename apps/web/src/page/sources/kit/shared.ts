import { GcpConnectorPublicId, ScrapeTargetPublicId, SourcePublicId, type V2Source } from "@maple/domain/http/v2"
import {
	isPushSourcePlatform,
	type PullSourcePlatform,
	type ScrapeTargetId,
	type SourceAttributeMode,
	type SourceSignal,
} from "@maple/domain/primitives"
import { Option, Schema } from "effect"
import { AppRoute, hrefOf } from "../../../route"
import { SOURCE_TABS, type SourceTab } from "../../../route/search"
import { statusRank } from "./status"

// Shared source constants and `orderSources`.

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

/** Default source first, then worst status first, then the API's order (newest first). */
export const orderSources = (sources: ReadonlyArray<V2Source>): ReadonlyArray<V2Source> => [
	...sources.filter((source) => source.is_default),
	...sources.filter((source) => !source.is_default).toSorted((a, b) => statusRank(a) - statusRank(b)),
]

/** `/sources/$sourceId` in its public id form; the overview tab drops `tab`. */
export const sourceHref = (source: V2Source, tab: SourceTab = "overview"): string =>
	hrefOf(
		AppRoute.Source({
			sourceId: toPublicSourceId(source.id),
			search: tab === "overview" ? {} : { tab },
		}),
	)

/** A source Maple collects through an integration (no token, a Connection tab instead of Setup). */
export const integrationPlatformOf = (source: V2Source): PullSourcePlatform | null =>
	isPushSourcePlatform(source.platform) ? null : source.platform

/** The integration whose page a source embeds; Supabase has none until its dashboard ships. */
export const embeddedIntegrationOf = (source: V2Source): Exclude<PullSourcePlatform, "supabase"> | null => {
	const platform = integrationPlatformOf(source)
	return platform === null || platform === "supabase" ? null : platform
}

/** The tabs a source shows: Setup for push sources, Connection for integration sources. */
export const tabsOf = (source: V2Source): ReadonlyArray<SourceTab> => {
	const hidden: SourceTab = integrationPlatformOf(source) === null ? "connection" : "setup"
	return SOURCE_TABS.filter((tab) => tab !== hidden)
}

/** `?tab=` as this source shows it: a link to the other kind's tab opens this kind's one. */
export const effectiveTab = (source: V2Source, tab: SourceTab): SourceTab =>
	tabsOf(source).includes(tab) ? tab : integrationPlatformOf(source) === null ? "setup" : "connection"

const VIA = {
	prometheus: "Scrape target",
	cloudflare: "OAuth · read-only",
	gcp: "Project connector",
	railway: "API token",
	planetscale: "OAuth",
	github: "GitHub App",
	supabase: "OAuth",
} as const satisfies Record<PullSourcePlatform, string>

/** How the source reaches Maple: its token prefix, the org keys, or the integration's credential. */
export const viaLabel = (source: V2Source): string => {
	const platform = integrationPlatformOf(source)
	if (platform !== null) return VIA[platform]
	if (source.key_prefix !== null) return `${source.key_prefix}…`
	return source.is_default ? "Org ingest keys" : "-"
}

const decodeScrapeTargetId = Schema.decodeUnknownOption(ScrapeTargetPublicId)

/** A Prometheus source's own scrape target, as the scrape-target reads key it (the decoded UUID). */
export const scrapeTargetIdOf = (source: V2Source): ScrapeTargetId | null =>
	source.platform !== "prometheus" || source.integration_id === null
		? null
		: Option.getOrNull(decodeScrapeTargetId(source.integration_id))

const decodeGcpConnectorId = Schema.decodeUnknownOption(GcpConnectorPublicId)

/** The record an integration source's card focuses on: its scrape target or Google Cloud connector. */
export const focusIdOf = (source: V2Source): string | null =>
	source.platform === "gcp" && source.integration_id !== null
		? Option.getOrNull(decodeGcpConnectorId(source.integration_id))
		: scrapeTargetIdOf(source)
