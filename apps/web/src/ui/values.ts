import { getServiceColor } from "@maple/ui/lib/colors"
import { ERROR_RATE_TEXT, errorRateLevel } from "@maple/ui/lib/error-rate"
import { formatErrorRate, formatLatency } from "@maple/ui/lib/format"
import {
	LATENCY_TEXT_TONE,
	latencyLevel,
	latencyLevelLabel,
	type LatencyScale,
} from "@maple/ui/lib/latency-tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// Small value components from packages/ui/src/components: LatencyValue, ErrorRateValue, ServiceDot.

/** `LatencyValue`: formatted and toned by magnitude against a percentile budget. */
export const latencyValue = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ ms: number; scale?: LatencyScale; className?: string }>,
): Html => {
	const level = latencyLevel(options.ms, options.scale ?? "p95")
	return h.span(
		[
			h.Title(latencyLevelLabel(level)),
			h.Class(cn("font-mono tabular-nums", LATENCY_TEXT_TONE[level], options.className)),
		],
		[formatLatency(options.ms)],
	)
}

/** `ErrorRateValue`. */
export const errorRateValue = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ rate: number; className?: string }>,
): Html =>
	h.span(
		[
			h.Class(
				cn(
					"font-mono tabular-nums",
					ERROR_RATE_TEXT[errorRateLevel(options.rate)],
					options.className,
				),
			),
		],
		[formatErrorRate(options.rate)],
	)

/** `ServiceDot`: the service's deterministic colour blob. */
export const serviceDot = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ serviceName: string; size?: "sm" | "default"; className?: string }>,
): Html =>
	h.span(
		[
			h.AriaHidden(true),
			h.Class(
				cn(
					"shrink-0 rounded-dot [corner-shape:squircle]",
					options.size === "sm" ? "size-1.5" : "size-2",
					options.className,
				),
			),
			h.Style({ "background-color": getServiceColor(options.serviceName) }),
		],
		[],
	)
