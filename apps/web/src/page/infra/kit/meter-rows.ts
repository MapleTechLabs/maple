import { severityLevel } from "../../../components/infra/format"
import { BAR_FILL, BAR_VALUE_TONE } from "../../../components/infra/severity-tokens"
import { EMPTY_VALUE, formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { meter } from "../../../ui/meter"

// `MeterRows`.

export type MeterRow = Readonly<{ label: string; fraction: number }>

const meterRow = <M>(h: HtmlBuilder<M>, row: MeterRow, hideLabel: boolean): Html => {
	const finite = Number.isFinite(row.fraction)
	const clamped = finite ? Math.max(0, Math.min(1, row.fraction)) : 0
	const level = severityLevel(clamped)
	return h.div(
		[h.Key(row.label), h.Class("flex items-center gap-2 leading-none")],
		[
			...(hideLabel
				? []
				: [
						h.span(
							[
								h.Class(
									cn(
										"w-8",
										"shrink-0 font-mono text-3xs tracking-wider text-foreground-subtle",
									),
								),
							],
							[row.label],
						),
					]),
			meter(h, {
				value: clamped,
				className: "h-[3px] flex-1 rounded-[1px]",
				fillClassName: BAR_FILL[level],
			}),
			h.span(
				[
					h.Class(
						cn(
							"w-9",
							"shrink-0 text-right font-mono text-2xs tabular-nums",
							BAR_VALUE_TONE[level],
						),
					),
				],
				[finite ? formatPercent(row.fraction) : EMPTY_VALUE],
			),
		],
	)
}

export const meterRows = <M>(
	h: HtmlBuilder<M>,
	meters: ReadonlyArray<MeterRow>,
	options: Readonly<{ hideLabels?: boolean; className?: string }> = {},
): Html =>
	h.div(
		[h.Class(cn("flex flex-col gap-1", options.className))],
		meters.map((row) => meterRow(h, row, options.hideLabels === true)),
	)
