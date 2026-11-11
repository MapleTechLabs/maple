import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { segmentedBar } from "@maple/views/ui/meter"

// `ThresholdScale`: a good / needs-work / poor track split at two thresholds, with a marker at the
// reading (a Web Vital's p75 against web.dev's thresholds).

// How far past the poor threshold the track runs, so a poor reading still has room to sit in.
const OVERSHOOT = 1.5

export const thresholdScale = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ value: number; good: number; poor: number; label: string; className?: string }>,
): Html => {
	const max = options.poor * OVERSHOOT
	const at = Math.min(100, Math.max(0, (options.value / max) * 100))
	return h.div(
		[h.Class(cn("relative py-0.5", options.className)), h.Role("img"), h.AriaLabel(options.label)],
		[
			segmentedBar(h, {
				className: "w-full gap-px bg-transparent",
				total: max,
				segments: [
					{ key: "good", value: options.good, className: TONE_FILL.ok },
					{ key: "needs", value: options.poor - options.good, className: TONE_FILL.warn },
					{ key: "poor", value: max - options.poor, className: TONE_FILL.crit },
				],
			}),
			h.div([
				h.AriaHidden(true),
				h.Class("absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-2xs bg-foreground"),
				h.Style({ left: `${at}%` }),
			]),
		],
	)
}
