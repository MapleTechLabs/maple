import { cn } from "@maple/ui/lib/utils"
import {
	type StatFigureSize,
	statFigureBlockStyles,
	statFigureCaptionStyles,
	statFigureLabelStyles,
	statFigureStyles,
	statFigureUnitSizeStyles,
	statFigureUnitStyles,
	statFigureValueDisplayStyles,
	statFigureValueMonoStyles,
	statFigureValueSizeStyles,
	statFigureValueStyles,
} from "@maple/ui/styles/ui/stat-figure"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/stat-figure.tsx: a headline number with a muted unit.
// With a `label` or `caption` it is a whole KPI: label above, the value, the caption below.

export interface StatFigureOptions {
	readonly value: Html | string
	readonly unit?: Html | string
	readonly size?: StatFigureSize
	/** Mono figures for readouts; `false` sets the value in the display face. */
	readonly mono?: boolean
	readonly className?: string
	readonly valueClassName?: string
	/** The KPI's name, above the value. */
	readonly label?: Html | string
	/** One line of context under the value. */
	readonly caption?: Html | string
}

export const statFigure = <M>(h: HtmlBuilder<M>, options: StatFigureOptions): Html => {
	const { label, caption } = options
	if (label === undefined && caption === undefined) return figure(h, options, options.className)
	return h.div(
		[h.Class(cn(statFigureBlockStyles, options.className))],
		[
			...(label === undefined ? [] : [h.span([h.Class(statFigureLabelStyles)], [label])]),
			figure(h, options),
			...(caption === undefined ? [] : [h.span([h.Class(statFigureCaptionStyles)], [caption])]),
		],
	)
}

const figure = <M>(h: HtmlBuilder<M>, options: StatFigureOptions, className?: string): Html => {
	const size = options.size ?? "md"
	return h.span(
		[h.Class(cn(statFigureStyles, className))],
		[
			h.span(
				[
					h.Class(
						cn(
							statFigureValueStyles,
							(options.mono ?? true) ? statFigureValueMonoStyles : statFigureValueDisplayStyles,
							statFigureValueSizeStyles[size],
							options.valueClassName,
						),
					),
				],
				[options.value],
			),
			...(options.unit
				? [
						h.span(
							[h.Class(cn(statFigureUnitStyles, statFigureUnitSizeStyles[size]))],
							[options.unit],
						),
					]
				: []),
		],
	)
}
