import { formatCell } from "../../../components/ai-elements/renderers/components/data-table-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"

// The data table a tool's structured output renders as.

export type DataTableProps = Readonly<{
	headers: ReadonlyArray<string>
	rows: ReadonlyArray<ReadonlyArray<string>>
	title?: string
}>

/** The structured renderer's table: an optional title over a capped, scrolling `xs` table. */
export const dataTable = <M>(h: HtmlBuilder<M>, props: DataTableProps): Html =>
	h.div(
		[h.Class("space-y-1")],
		[
			...(props.title === undefined || props.title === ""
				? []
				: [h.p([h.Class("text-2xs font-medium text-muted-foreground")], [props.title])]),
			h.div(
				[h.Class("max-h-[300px] overflow-auto")],
				[
					table(h, { size: "xs", scroll: false }, [
						tableHeader(h, [
							tableRow(
								h,
								props.headers.map((header) => tableHead(h, [header])),
							),
						]),
						tableBody(
							h,
							props.rows.map((row) =>
								tableRow(
									h,
									row.map((cell, j) =>
										tableCell(
											h,
											[
												h.span(
													[h.Class("block max-w-[200px] truncate"), h.Title(cell)],
													[formatCell(cell, props.headers[j])],
												),
											],
											"py-1",
										),
									),
								),
							),
						),
					]),
				],
			),
		],
	)
