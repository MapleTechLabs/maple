import { describe, expect, it } from "vitest"
import { createQueryDraft, resetQueryForDataSource } from "@maple/query-engine/query-builder"
import type { QueryBuilderWidgetState } from "@/lib/query-builder/widget-builder-utils"
import { defaultFunnelDraft } from "@/lib/query-builder/widget-builder-shared"
import { reconcileFunnelSource } from "./funnel-source"

const base = (): QueryBuilderWidgetState => ({
	visualization: "chart",
	title: "",
	description: "",
	timeRange: null,
	chartId: "query-builder-line",
	stacked: false,
	curveType: "linear",
	queries: [createQueryDraft(0)],
	formulas: [],
	comparisonMode: "none",
	includePercentChange: true,
	statAggregate: "first",
	statValueField: "",
	unit: "number",
	legendPosition: "bottom",
	seriesStatsEnabled: false,
	pointsMode: "auto",
	tableLimit: "",
	listDataSource: "traces",
	listWhereClause: "",
	listLimit: "",
	listColumns: [],
	listRootOnly: true,
	heatmapColorScale: "blues",
	heatmapScaleType: "linear",
	thresholds: [],
	gaugeMin: "",
	gaugeMax: "",
	sparklineEnabled: false,
	markdownContent: "",
	funnel: defaultFunnelDraft(),
})

describe("reconcileFunnelSource", () => {
	it("opens the step editor when a funnel's first query is product events", () => {
		const state = {
			...base(),
			visualization: "funnel" as const,
			queries: [resetQueryForDataSource(createQueryDraft(0), "product_events")],
		}
		const next = reconcileFunnelSource(state)
		expect(next.funnel.source).toBe("product_events")
		expect(next.funnel.steps).toHaveLength(1)
	})

	it("leaves a traces funnel on the query set", () => {
		const state = { ...base(), visualization: "funnel" as const }
		expect(reconcileFunnelSource(state)).toBe(state)
	})

	it("turns a product-event funnel into a product-event count query when the type changes", () => {
		const state = {
			...base(),
			visualization: "hbar" as const,
			funnel: { ...base().funnel, source: "product_events" as const },
		}
		const next = reconcileFunnelSource(state)
		expect(next.funnel.source).toBe("query_set")
		expect(next.queries[0]?.dataSource).toBe("product_events")
	})
})
