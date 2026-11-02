import { type CacheInfo, getCacheInfo } from "@maple/ui/lib/cache"
import { extractClassName } from "@maple/ui/lib/colors"
import { getHttpInfo, type HttpInfo } from "@maple/ui/lib/http"
import { getSpanKindLabel, normalizeSpanKind, SPAN_KIND_LABELS } from "@maple/ui/lib/span-kind"
import type { Span } from "@maple/ui/lib/types"
import type { IconName } from "../../ui/icon"
import { type CloudPlatformInfo, getCloudPlatform } from "./cloud-platforms"

// copied: packages/ui/src/lib/span-category.ts with `Icon` as an icon name (the original
// imports React icon components). Phase 1 should split it like `service-map-db-style.ts`.

export type SpanCategoryId =
	| "server"
	| "http"
	| "db"
	| "cache"
	| "messaging"
	| "platform"
	| "function"
	| "internal"

export interface SpanCategoryAccent {
	readonly rail: string
	readonly text: string
	readonly soft: string
}

export interface SpanCategory {
	readonly id: SpanCategoryId
	readonly label: string
	readonly icon: IconName
	readonly accent: SpanCategoryAccent
}

const ACCENTS = {
	server: { rail: "bg-chart-1", text: "text-chart-1", soft: "bg-chart-1/15" },
	http: { rail: "bg-chart-2", text: "text-chart-2", soft: "bg-chart-2/15" },
	db: { rail: "bg-chart-3", text: "text-chart-3", soft: "bg-chart-3/15" },
	cache: { rail: "bg-chart-4", text: "text-chart-4", soft: "bg-chart-4/15" },
	function: { rail: "bg-chart-5", text: "text-chart-5", soft: "bg-chart-5/15" },
	messaging: { rail: "bg-chart-throughput", text: "text-chart-throughput", soft: "bg-chart-throughput/15" },
	platform: { rail: "bg-chart-p95", text: "text-chart-p95", soft: "bg-chart-p95/15" },
	internal: { rail: "bg-severity-trace", text: "text-severity-trace", soft: "bg-severity-trace-a2" },
} satisfies Record<SpanCategoryId, SpanCategoryAccent>

/** Ordered legend entries: default label and icon per category. */
export const SPAN_CATEGORIES: ReadonlyArray<SpanCategory> = [
	{ id: "server", label: "Server", icon: "PulseIcon", accent: ACCENTS.server },
	{ id: "http", label: "HTTP", icon: "GlobePointerIcon", accent: ACCENTS.http },
	{ id: "db", label: "Database", icon: "DatabaseIcon", accent: ACCENTS.db },
	{ id: "cache", label: "Cache", icon: "StackPerspectiveIcon", accent: ACCENTS.cache },
	{ id: "messaging", label: "Messaging", icon: "MessagesIcon", accent: ACCENTS.messaging },
	{ id: "platform", label: "Platform", icon: "IndustryIcon", accent: ACCENTS.platform },
	{ id: "function", label: "Function", icon: "PuzzlePieceIcon", accent: ACCENTS.function },
	{ id: "internal", label: "Internal", icon: "CodeIcon", accent: ACCENTS.internal },
]

export type SpanCategoryInput = Pick<Span, "spanName" | "spanKind"> & {
	spanAttributes?: Record<string, string>
}

export interface SpanDescription {
	readonly category: SpanCategory
	readonly httpInfo: HttpInfo | null
	readonly cacheInfo: CacheInfo | null
	readonly platform: CloudPlatformInfo | null
	readonly className: string | null
}

const categoryOf = (
	span: SpanCategoryInput,
	cacheInfo: CacheInfo | null,
	platform: CloudPlatformInfo | null,
	httpInfo: HttpInfo | null,
	className: string | null,
): SpanCategory => {
	const spanKind = normalizeSpanKind(span.spanKind)
	if (cacheInfo)
		return {
			id: "cache",
			label: cacheInfo.system ?? "Cache",
			icon: "StackPerspectiveIcon",
			accent: ACCENTS.cache,
		}
	if (platform) {
		if (platform.id === "database")
			return { id: "db", label: platform.label, icon: "DatabaseIcon", accent: ACCENTS.db }
		return { id: "platform", label: platform.kind, icon: platform.icon, accent: ACCENTS.platform }
	}
	if (httpInfo) {
		return httpInfo.kind === "server" || spanKind === "SERVER"
			? { id: "server", label: "Server", icon: "PulseIcon", accent: ACCENTS.server }
			: { id: "http", label: "HTTP", icon: "GlobePointerIcon", accent: ACCENTS.http }
	}
	if (spanKind === "SERVER")
		return { id: "server", label: "Server", icon: "PulseIcon", accent: ACCENTS.server }
	if (spanKind === "PRODUCER" || spanKind === "CONSUMER") {
		const isProducer = spanKind === "PRODUCER"
		return {
			id: "messaging",
			label: SPAN_KIND_LABELS[`SPAN_KIND_${spanKind}`],
			icon: isProducer ? "PaperPlaneIcon" : "BoxArchiveIcon",
			accent: ACCENTS.messaging,
		}
	}
	if (className)
		return { id: "function", label: "Function", icon: "PuzzlePieceIcon", accent: ACCENTS.function }
	const kindLabel = spanKind
		? getSpanKindLabel(spanKind)
		: span.spanKind.replace(/^SPAN_KIND_/, "") || "Internal"
	return { id: "internal", label: kindLabel, icon: "CodeIcon", accent: ACCENTS.internal }
}

/** Categorize a span for display: cache, then platform, then HTTP, then span kind. */
export function describeSpan(span: SpanCategoryInput): SpanDescription {
	const attrs = span.spanAttributes ?? {}
	const cacheInfo = getCacheInfo(attrs)
	const platform = getCloudPlatform(attrs)
	const httpInfo = getHttpInfo(span)
	const className = extractClassName(span.spanName)
	return {
		category: categoryOf(span, cacheInfo, platform, httpInfo, className),
		httpInfo,
		cacheInfo,
		platform,
		className,
	}
}
