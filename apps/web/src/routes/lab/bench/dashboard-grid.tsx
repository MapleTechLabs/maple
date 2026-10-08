import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardGridBench } from "@/lab/bench/dashboard-grid/dashboard-grid-bench"

const SearchSchema = Schema.Struct({
	n: Schema.optional(Schema.Number),
})

export const Route = createFileRoute("/lab/bench/dashboard-grid")({
	component: DashboardGridBenchPage,
	validateSearch: Schema.toStandardSchemaV1(SearchSchema),
})

function DashboardGridBenchPage() {
	const { n = 50 } = Route.useSearch()
	return <DashboardGridBench key={n} count={n} />
}
