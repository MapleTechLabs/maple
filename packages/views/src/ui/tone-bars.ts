import { TONE_FILL, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Array as Arr } from "effect"

// `ToneBars`.

export type ToneBar = Readonly<{ key: string; value: number; tone: Tone; title: string }>

/** Only a zero-height bar disappears; the shortest still shows as a sliver. */
const MIN_HEIGHT_PERCENT = 12

/**
 * `ToneBars`: a row of bars scaled to the tallest, each in its own tone and titled with its value
 * (a build-time history with the failed builds in red).
 */
export const toneBars = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ bars: ReadonlyArray<ToneBar>; label: string; className?: string }>,
): Html => {
	const max = Math.max(0, ...Arr.map(options.bars, (bar) => bar.value))
	return h.div(
		[
			h.Role("img"),
			h.AriaLabel(options.label),
			h.Class(cn("flex h-8 items-end gap-0.5", options.className)),
		],
		Arr.map(options.bars, (bar) =>
			h.div([
				h.Key(bar.key),
				h.Title(bar.title),
				h.Class(cn("min-w-0 flex-1 rounded-2xs", TONE_FILL[bar.tone])),
				h.Style({
					height: `${Math.max(max > 0 ? (bar.value / max) * 100 : 0, MIN_HEIGHT_PERCENT)}%`,
				}),
			]),
		),
	)
}
