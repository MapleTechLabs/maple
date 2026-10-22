import {
	DISPLAY_ROW_LIMIT,
	formatCell,
	inferColumns,
	isNumericColumn,
	truncateCell,
} from "../../lib/query-console"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { icon } from "@maple/web/ui/icon"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ResultRow } from "./model"

// The Query page's result table and its error state.

export const queryError = <M>(h: HtmlBuilder<M>, title: string, detail: string): Html =>
	h.div(
		[h.Class("p-4")],
		[
			h.div(
				[h.Class("rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3")],
				[
					h.div(
						[h.Class("flex items-center gap-2 text-sm font-medium text-destructive")],
						[icon(h, "CircleWarningIcon", { className: "size-4 shrink-0" }), title],
					),
					h.pre(
						[h.Class("mt-2 font-mono text-xs whitespace-pre-wrap break-all text-foreground")],
						[detail],
					),
				],
			),
		],
	)

export const resultTable = <M>(h: HtmlBuilder<M>, rows: ReadonlyArray<ResultRow>): Html => {
	const columns = inferColumns(rows)
	const numeric = new Set(columns.filter((column) => isNumericColumn(rows, column)))
	const shown = rows.length > DISPLAY_ROW_LIMIT ? rows.slice(0, DISPLAY_ROW_LIMIT) : rows
	return h.div(
		[],
		[
			h.table(
				[h.Class("w-max min-w-full border-separate border-spacing-0 font-mono text-xs")],
				[
					h.thead(
						[],
						[
							h.tr(
								[],
								columns.map((column) =>
									h.th(
										[
											h.Key(column),
											h.Class(
												cn(
													"sticky top-0 z-10 border-b bg-background px-3 py-2 font-medium whitespace-nowrap text-muted-foreground",
													numeric.has(column) ? "text-right" : "text-left",
												),
											),
										],
										[column],
									),
								),
							),
						],
					),
					h.tbody(
						[],
						shown.map((row, index) =>
							h.tr(
								[h.Key(String(index)), h.Class("hover:bg-accent/40")],
								columns.map((column) => {
									const text = formatCell(row[column])
									return h.td(
										[
											h.Key(column),
											h.Title(text),
											h.Class(
												cn(
													"border-b border-border/50 px-3 py-1.5 whitespace-nowrap",
													numeric.has(column) && "text-right tabular-nums",
													(row[column] === null || row[column] === undefined) &&
														"text-muted-foreground/60",
												),
											),
										],
										[truncateCell(text)],
									)
								}),
							),
						),
					),
				],
			),
			...(rows.length > DISPLAY_ROW_LIMIT
				? [
						h.p(
							[h.Class("px-3 py-2 text-xs text-muted-foreground")],
							[
								"Showing the first ",
								formatNumber(DISPLAY_ROW_LIMIT),
								" of ",
								formatNumber(rows.length),
								" rows. Download CSV or JSON for the full result.",
							],
						),
					]
				: []),
		],
	)
}
