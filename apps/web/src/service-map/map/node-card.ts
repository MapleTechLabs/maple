import type { DbIconKey } from "@maple/ui/components/service-map/service-map-db-style"
import type { ServicePlatform } from "@maple/ui/components/service-map/service-map-types"
import { ERROR_RATE_TEXT, type ErrorRateLevel, errorRateLevel } from "@maple/ui/lib/error-rate"
import { formatErrorRate, formatLatency, formatRate } from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { type UtilizationLevel } from "@maple/ui/lib/utilization"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { IconName } from "../../ui/icon"
import { eyebrow } from "../../ui/eyebrow"

// Shared pieces of `ServiceMapNode` (packages/ui `service-map/service-map-node.tsx`).

export const HANDLE_CLASSES = "!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"

interface PlatformGlyph {
	readonly icon: IconName
	readonly label: string
	readonly branded: boolean
}

export const PLATFORM_ICON = {
	kubernetes: { icon: "KubernetesIcon", label: "Kubernetes", branded: true },
	cloudflare: { icon: "CloudflareBrandIcon", label: "Cloudflare Workers", branded: true },
	gcp: { icon: "GoogleCloudIcon", label: "Google Cloud", branded: true },
	lambda: { icon: "AwsLambdaIcon", label: "AWS Lambda", branded: true },
	web: { icon: "GlobeIcon", label: "Web (browser)", branded: false },
	unknown: { icon: "ServerIcon", label: "Unknown runtime", branded: false },
	none: { icon: "ServerIcon", label: "Unknown runtime", branded: false },
} satisfies Record<ServicePlatform | "none", PlatformGlyph>

export const DB_ICON = {
	postgres: "PostgresIcon",
	mysql: "MysqlIcon",
	clickhouse: "ClickhouseIcon",
	mongodb: "MongodbIcon",
	redis: "RedisIcon",
	database: "DatabaseIcon",
	fire: "FireIcon",
	"paper-plane": "PaperPlaneIcon",
	magnifier: "MagnifierIcon",
	cloudflare: "CloudflareBrandIcon",
	planetscale: "PlanetScaleIcon",
} satisfies Record<DbIconKey, IconName>

export const UTILIZATION_TEXT = {
	crit: TONE_TEXT.crit,
	warn: TONE_TEXT.warn,
	ok: undefined,
} satisfies Record<UtilizationLevel, string | undefined>

export const HEALTH_TONE = { crit: "crit", warn: "warn", neutral: "ok" } satisfies Record<
	ErrorRateLevel,
	Tone
>

const SELECTED_BORDER_CLASS = {
	crit: "border-severity-error ring-[3px] ring-severity-error/15",
	warn: "border-severity-warn ring-[3px] ring-severity-warn/15",
	neutral: "border-foreground/40 ring-[3px] ring-foreground/15",
} satisfies Record<ErrorRateLevel, string>

export const selectedBorderClass = (errorRate: number): string =>
	SELECTED_BORDER_CLASS[errorRateLevel(errorRate)]

export const errorRateClass = (errorRate: number): string => {
	const level = errorRateLevel(errorRate)
	return level === "neutral" ? "text-secondary-foreground" : ERROR_RATE_TEXT[level]
}

/** Base UI `<TooltipTrigger>`: a bare button around the trigger content (the popup is not ported). */
export const tooltipTrigger = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.button(
		[
			h.Attribute("data-base-ui-tooltip-trigger", ""),
			h.DataAttribute("slot", "tooltip-trigger"),
			h.Type("button"),
		],
		children,
	)

export const metricCell = <M>(
	h: HtmlBuilder<M>,
	label: string,
	value: string,
	valueClassName?: string,
): Html =>
	h.div(
		[h.Class("flex flex-col gap-px")],
		[
			eyebrow(h, { className: "text-4xs text-foreground-subtle" }, [label]),
			h.span(
				[
					h.Class(
						cn(
							"text-2xs font-medium font-mono tabular-nums text-secondary-foreground",
							valueClassName,
						),
					),
				],
				[value],
			),
		],
	)

export const avgCell = <M>(h: HtmlBuilder<M>, avgLatencyMs: number): Html =>
	metricCell(h, "avg", formatLatency(avgLatencyMs), latencyToneClass(avgLatencyMs, "avg"))

export const errCell = <M>(h: HtmlBuilder<M>, errorRate: number): Html =>
	metricCell(h, "err%", formatErrorRate(errorRate), errorRateClass(errorRate))

export const rateText = (throughput: number, hasSampling: boolean): string =>
	`${hasSampling ? "~" : ""}${formatRate(throughput)}`
