import { cn } from "@maple/ui/lib/utils"
import {
	type StatFigureSize,
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

export interface StatFigureOptions {
	readonly value: Html | string
	readonly unit?: Html | string
	readonly size?: StatFigureSize
	/** Mono figures for readouts; `false` sets the value in the display face. */
	readonly mono?: boolean
	readonly className?: string
	readonly valueClassName?: string
}

export const statFigure = <M>(h: HtmlBuilder<M>, options: StatFigureOptions): Html => {
	const size = options.size ?? "md"
	return h.span(
		[h.Class(cn(statFigureStyles, options.className))],
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
