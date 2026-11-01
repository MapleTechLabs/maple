import { getServiceColor } from "@maple/ui/lib/colors"
import { ERROR_RATE_TEXT, errorRateLevel } from "@maple/ui/lib/error-rate"
import { formatErrorRate, formatLatency } from "@maple/ui/lib/format"
import {
	LATENCY_TEXT_TONE,
	latencyLevel,
	latencyLevelLabel,
	type LatencyScale,
} from "@maple/ui/lib/latency-tone"
import { EMPTY_VALUE } from "@maple/ui/lib/empty-value"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// Small value components from packages/ui/src/components: LatencyValue, ErrorRateValue, ServiceDot.

/** A zero, a missing value and the `—` placeholder all read in this one quiet grey. */
export const NIL_VALUE = "text-foreground-subtle"

/** The `—` placeholder for a missing value, in the nil grey. */
export const emptyValue = <M>(h: HtmlBuilder<M>, className?: string): Html =>
	h.span([h.Class(cn(NIL_VALUE, className))], [EMPTY_VALUE])

/** A unit straight after a digit (any letter, so the Greek mu of `397μs` too): the `ms` of `29ms`, the ` KB` of `9.2 KB`, the `h` and `m` of `1h 5m`. */
const UNIT_AFTER_DIGIT = /(?<=\d)(\s?[\p{L}%]+)/u

/** A formatted value whose units sit a grey step under the number, so a column scans by magnitude.
 *  `unitClassName` names that step; toned values pass `null` to keep the unit in the tone. */
export const measure = <M>(
	h: HtmlBuilder<M>,
	text: string,
	unitClassName: string | null = "text-muted-foreground",
): ReadonlyArray<Html | string> =>
	unitClassName === null
		? [text]
		: text.split(UNIT_AFTER_DIGIT).flatMap((part, index): ReadonlyArray<Html | string> => {
				if (part === "") return []
				return index % 2 === 1 ? [h.span([h.Class(unitClassName)], [part])] : [part]
			})

// A unit under a neutral latency drops one grey step; under a warn or error tone it keeps the tone.
const LATENCY_UNIT = {
	quiet: "text-foreground-subtle",
	nominal: "text-muted-foreground",
	elevated: "text-muted-foreground",
	slow: null,
	critical: null,
} satisfies Record<keyof typeof LATENCY_TEXT_TONE, string | null>

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
		measure(h, formatLatency(options.ms), LATENCY_UNIT[level]),
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
