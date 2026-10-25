import type { V2DashboardTemplate, V2DashboardTemplatePreview } from "@maple/domain/http/v2"
import { ALL_VALUE, type ResolvedVariable, type VariableValues } from "@maple/query-engine"
import { countLabel } from "@maple/ui/lib/format"
import { formatRelativeFrom, toEpochMs } from "@maple/ui/lib/time-format"
import type { IconName } from "../../../ui/icon"
import type { MetricSeen } from "./model"

/** The empty-dashboard template, pinned below the list and excluded from every count. */
export const BLANK_TEMPLATE_ID = "blank"

export const CATEGORY_LABELS = new Map([
	["application", "Application"],
	["database", "Databases"],
	["infrastructure", "Infrastructure"],
	["messaging", "Messaging"],
])

export const CATEGORY_ORDER = ["application", "database", "infrastructure", "messaging"] as const

/** "3 stats · 3 charts": line, area and bar all read as charts. */
export const compositionLabel = (preview: V2DashboardTemplate["preview"]): string => {
	const stats = preview.filter((widget) => widget.kind === "stat").length
	const tables = preview.filter((widget) => widget.kind === "table").length
	const lists = preview.filter((widget) => widget.kind === "list").length
	const charts = preview.length - stats - tables - lists
	return [
		stats > 0 ? countLabel(stats, "stat") : null,
		charts > 0 ? countLabel(charts, "chart") : null,
		tables > 0 ? countLabel(tables, "table") : null,
		lists > 0 ? countLabel(lists, "list") : null,
	]
		.filter((part) => part !== null)
		.join(" · ")
}

export const widgetCountLabel = (template: V2DashboardTemplate): string =>
	countLabel(template.preview.length, "widget")

/** Matches name, description and tags. */
export const templateMatches = (template: V2DashboardTemplate, query: string): boolean => {
	const needle = query.trim().toLowerCase()
	if (needle.length === 0) return true
	return (
		template.name.toLowerCase().includes(needle) ||
		template.description.toLowerCase().includes(needle) ||
		template.tags.some((tag) => tag.toLowerCase().includes(needle))
	)
}

/** "12s ago", or `null` when the timestamp is unusable. */
export const relativeAge = (iso: string | null, now: number): string | null => {
	if (iso === null) return null
	const epochMs = toEpochMs(iso)
	return Number.isFinite(epochMs) ? formatRelativeFrom(epochMs, now) : null
}

/** Where a gated template sends you to fix the gap (`setupDestination`). */
export const setupHref = (template: V2DashboardTemplate): string =>
	template.requirement?.kind === "integration" ? "/sources/new" : "/settings?tab=ingestion"

const TEMPLATE_ICONS = new Map<string, IconName>([
	["service-health", "PulseIcon"],
	["error-tracking", "CircleWarningIcon"],
	["platform-overview", "LayersIcon"],
	["http-endpoints", "GlobeIcon"],
	["top-errors", "AlertWarningIcon"],
	["metric-overview", "ChartLineIcon"],
	["jvm-runtime", "OpenjdkIcon"],
	["nodejs-runtime", "NodejsIcon"],
	["grpc-service", "NetworkNodesIcon"],
	["blank", "GridSquareCirclePlusIcon"],
	["postgres-overview", "PostgresIcon"],
	["mysql-overview", "MysqlIcon"],
	["redis-overview", "RedisIcon"],
	["mongodb-overview", "MongodbIcon"],
	["cloudflare", "CloudflareBrandIcon"],
	["gcp", "GoogleCloudIcon"],
	["planetscale", "PlanetScaleIcon"],
	["host-metrics", "ServerIcon"],
	["kubernetes-cluster", "KubernetesIcon"],
	["kubernetes-pod", "KubernetesIcon"],
	["kafka-overview", "KafkaIcon"],
	["nats-overview", "NatsIcon"],
	["rabbitmq-overview", "RabbitmqIcon"],
])

const CATEGORY_ICONS = new Map<string, IconName>([
	["application", "ChartLineIcon"],
	["database", "DatabaseIcon"],
	["infrastructure", "ServerIcon"],
	["messaging", "PaperPlaneIcon"],
])

/** `templateIcon`: the template's own mark, else its category's. */
export const templateIcon = (templateId: string, category: string): IconName =>
	TEMPLATE_ICONS.get(templateId) ?? CATEGORY_ICONS.get(category) ?? "ChartLineIcon"

// READINESS (`use-template-readiness.ts`)

/** The window `listMetrics` looks back over. */
export const READINESS_WINDOW_LABEL = "the last 24 h"

export interface TemplateReadiness {
	readonly ready: boolean
	readonly missingLabel: string | null
	readonly prefixLabel: string | null
	readonly metricCount: number
	readonly lastSeen: string | null
}

const READY: TemplateReadiness = {
	ready: true,
	missingLabel: null,
	prefixLabel: null,
	metricCount: 0,
	lastSeen: null,
}

const prefixLabel = (prefix: string): string | null => (prefix === "" ? null : `${prefix}*`)

const firstPrefixLabel = (prefixes: ReadonlyArray<string>): string | null =>
	prefixes.map(prefixLabel).find((value) => value !== null) ?? null

/** `computeTemplateReadiness`: `metrics: null` (unknown) reads every template as ready. */
export const computeReadiness = (
	templates: ReadonlyArray<V2DashboardTemplate>,
	metrics: ReadonlyArray<MetricSeen> | null,
): ReadonlyMap<string, TemplateReadiness> => {
	if (metrics === null) return new Map(templates.map((template) => [template.id, READY]))
	const matches = (prefix: string) =>
		prefix === "" ? metrics : metrics.filter((metric) => metric.metricName.startsWith(prefix))
	return new Map(
		templates.map((template): [string, TemplateReadiness] => {
			const prefixes = template.requiredMetricPrefixes
			if (prefixes.length === 0) return [template.id, READY]
			const matched = prefixes.map(matches)
			const ready = matched.every((rows) => rows.length > 0)
			const flat = matched.flat()
			return [
				template.id,
				{
					ready,
					missingLabel: ready
						? null
						: (template.requirement?.missing ?? `no ${firstPrefixLabel(prefixes) ?? "data"}`),
					prefixLabel: firstPrefixLabel(prefixes),
					metricCount: new Set(flat.map((metric) => metric.metricName)).size,
					lastSeen: flat.reduce<string | null>(
						(latest, metric) =>
							latest === null || metric.lastSeen > latest ? metric.lastSeen : latest,
						null,
					),
				},
			]
		}),
	)
}

/**
 * `previewVariableValues`: what a template's variables start on with no options loaded, the
 * declared default, else All. Without these a `"$project"` filter reaches the query literally.
 */
export const previewVariableValues = (variables: V2DashboardTemplatePreview["variables"]): VariableValues =>
	Object.fromEntries(
		variables.flatMap((variable): ReadonlyArray<readonly [string, ResolvedVariable]> =>
			variable.defaultValue !== undefined && variable.defaultValue !== ""
				? [[variable.name, { value: variable.defaultValue, isAll: false, options: [] }]]
				: variable.includeAll === true
					? [[variable.name, { value: ALL_VALUE, isAll: true, options: [] }]]
					: [],
		),
	)
