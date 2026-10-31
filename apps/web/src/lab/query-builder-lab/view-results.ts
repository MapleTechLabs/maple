import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../ui/display"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../ui/table"
import { seriesKeysOf } from "./derive"
import type { Message, Model, RunResult } from "./model"

// `QueryBuilderAtomResults` and the no-enabled-queries error in the Execution Results card.

type H = HtmlBuilder<Message>

const META = "text-2xs text-muted-foreground"

const errorOutcome = (h: H, name: string, message: string): Html =>
	h.div(
		[h.Class("space-y-2 border p-2")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					badge(h, { variant: "outline", className: "font-mono" }, [name]),
					badge(h, { variant: "destructive" }, ["error"]),
					h.span([h.Class(META)], ["query_engine"]),
				],
			),
			h.p([h.Class("text-2xs text-destructive")], [message]),
		],
	)

const resultsTable = (h: H, result: RunResult): Html => {
	const keys = seriesKeysOf(result.points)
	const mono = "font-mono text-2xs"
	return table(h, {}, [
		tableHeader(h, [tableRow(h, [tableHead(h, ["bucket"]), ...keys.map((key) => tableHead(h, [key]))])]),
		tableBody(
			h,
			result.points
				.slice(0, 12)
				.map((point) =>
					tableRow(
						h,
						[
							tableCell(h, [point.bucket], mono),
							...keys.map((key) => tableCell(h, [String(point.series[key] ?? 0)], mono)),
						],
						undefined,
						[h.Key(point.bucket)],
					),
				),
		),
	])
}

const successOutcome = (h: H, result: RunResult): Html =>
	h.div(
		[h.Class("space-y-2 border p-2")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					badge(h, { variant: "outline", className: "font-mono" }, ["Combined result"]),
					badge(h, { variant: "secondary" }, ["success"]),
					h.span([h.Class(META)], ["query_engine"]),
					h.span([h.Class(META)], [String(result.points.length), " buckets"]),
				],
			),
			...(result.warnings.length > 0
				? [
						h.div(
							[h.Class("space-y-1")],
							result.warnings.map((warning) =>
								h.p([h.Key(warning), h.Class(META)], ["- ", warning]),
							),
						),
					]
				: []),
			...(result.points.length > 0 ? [resultsTable(h, result)] : []),
		],
	)

const RUNNING = "Running query…"

export const resultsContent = (h: H, model: Model): Html => {
	if (model.noQueriesError !== null) return errorOutcome(h, "-", model.noQueriesError)
	if (model.submitted === null)
		return h.p([h.Class("text-xs text-muted-foreground")], ["Run the query to see results."])
	const data = model.results.data
	switch (data._tag) {
		case "Idle":
		case "Loading":
			return h.p([h.Class("text-xs text-muted-foreground")], [RUNNING])
		case "Failure":
		case "Stale":
			return errorOutcome(h, "Combined result", data.error.message)
		case "Success":
		case "Refreshing":
			return successOutcome(h, data.data)
	}
}
