import {
	DISPLAY_ROW_LIMIT,
	formatCell,
	inferColumns,
	isNumericColumn,
	truncateCell,
} from "../../lib/query-console"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import {
	numericTableCell,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import { typography, typographyClass } from "@maple/views/ui/typography"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ResultRow } from "./model"
import { Array as Arr } from "effect"

// The Query page's result table and its error state.

export const queryError = <M>(h: HtmlBuilder<M>, title: string, detail: string): Html =>
	h.div(
		[h.Class("p-4")],
		[
			h.div(
				[h.Class("rounded-md border border-destructive-a3 bg-destructive-a1 px-4 py-3")],
				[
					hstack(
						h,
						{
							gap: "2",
							className: cn(
								typographyClass({ size: "sm", weight: "medium" }),
								"text-destructive",
							),
						},
						[icon(h, "CircleWarningIcon", { className: "size-4 shrink-0" }), title],
					),
					h.pre(
						[
							h.Class(
								cn(
									typographyClass({ size: "xs", tone: "foreground", mono: true }),
									"mt-2 whitespace-pre-wrap break-all",
								),
							),
						],
						[detail],
					),
				],
			),
		],
	)

export const resultTable = <M>(h: HtmlBuilder<M>, rows: ReadonlyArray<ResultRow>): Html => {
	const columns = inferColumns(rows)
	const numeric = new Set(Arr.filter(columns, (column) => isNumericColumn(rows, column)))
	const shown = rows.length > DISPLAY_ROW_LIMIT ? rows.slice(0, DISPLAY_ROW_LIMIT) : rows
	return h.div(
		[],
		[
			// The page scrolls the table, so the container must not: its sticky header pins to the page.
			table(h, { size: "sm", scroll: false, className: "w-max min-w-full font-mono" }, [
				tableHeader(
					h,
					[
						tableRow(
							h,
							Arr.map(columns, (column) =>
								tableHead(h, [column], cn("px-3", numeric.has(column) && "text-right"), [
									h.Key(column),
								]),
							),
						),
					],
					{ sticky: true },
				),
				tableBody(
					h,
					Arr.map(shown, (row, index) =>
						tableRow(
							h,
							Arr.map(columns, (column) => {
								const text = formatCell(row[column])
								const cell = numeric.has(column) ? numericTableCell : tableCell
								return cell(
									h,
									[truncateCell(text)],
									cn(
										"px-3",
										(row[column] === null || row[column] === undefined) &&
											"text-foreground-subtle",
									),
									[h.Key(column), h.Title(text)],
								)
							}),
							undefined,
							[h.Key(String(index))],
						),
					),
				),
			]),
			...(rows.length > DISPLAY_ROW_LIMIT
				? [
						typography(h, { as: "p", size: "xs", tone: "muted", className: "px-3 py-2" }, [
							"Showing the first ",
							formatNumber(DISPLAY_ROW_LIMIT),
							" of ",
							formatNumber(rows.length),
							" rows. Download CSV or JSON for the full result.",
						]),
					]
				: []),
		],
	)
}
