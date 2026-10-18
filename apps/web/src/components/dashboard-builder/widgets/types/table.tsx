import { WIDGET_TYPES } from "@maple/domain/http"
import { makeQueryDataSource, dataSourceTransform } from "@maple/widgets/dashboard"

import { GridIcon } from "@/components/icons"
import { WidgetSettings, parseRowLimit } from "@/components/dashboard-builder/config/settings-fields"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import { tablePresets } from "@/components/dashboard-builder/widgets/widget-definitions"
import {
	extendDisplay,
	type WidgetTypeDefinition,
} from "@/components/dashboard-builder/widgets/widget-type-registry"
import { rowsPresetPreview } from "@/components/dashboard-builder/widgets/types/preset-preview"
import { TABLE_PRESET_SAMPLE_ROWS } from "@maple/web-data/dashboards/widget-preset-samples"
import {
	hasActiveGroupBy,
	inferDisplayUnitForQuery,
	isVisibleQuery,
} from "@/lib/query-builder/widget-builder-shared"

/**
 * Rows from the query builder. A grouped table is a breakdown (one row per
 * group); an ungrouped one is the raw timeseries, capped by the row limit.
 */
export const tableWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.table,
	icon: GridIcon,
	Renderer: TableWidget,
	queryEditor: "builder",
	ConfigPanel: () => (
		<>
			<WidgetSettings.RowLimit />
			<WidgetSettings.QueryOptions />
		</>
	),
	presets: tablePresets,
	PresetPreview: rowsPresetPreview(TABLE_PRESET_SAMPLE_ROWS),

	initialState: (widget) => ({
		tableLimit: ((limit) => (typeof limit === "number" ? String(limit) : ""))(
			dataSourceTransform(widget.dataSource)?.limit,
		),
	}),

	buildDataSource: ({ base, state, sharedTransform, visibleQueries }) => {
		const limit = parseRowLimit(state.tableLimit)

		if (visibleQueries.some(hasActiveGroupBy)) {
			return makeQueryDataSource({
				resultShape: "breakdown",
				queries: visibleQueries,
				...(limit ? { transform: { limit } } : undefined),
			})
		}

		if (!limit) return base
		return { ...base, transform: { ...sharedTransform, limit } }
	},

	buildDisplay: ({ base, state }) => {
		// A grouped table renders `{name, value}` rows, so its columns are derived
		// from the group-by rather than configured. Ungrouped tables let the
		// renderer infer columns from the rows.
		const groupByQuery = state.queries.find((query) => isVisibleQuery(query) && hasActiveGroupBy(query))
		if (!groupByQuery) return extendDisplay(base, { columns: undefined })

		const groupLabel =
			groupByQuery.groupBy.find((g) => g.trim() && g.trim().toLowerCase() !== "none") ?? "name"
		return extendDisplay(base, {
			columns: [
				{ field: "name", header: groupLabel, align: "left" },
				{
					field: "value",
					header: groupByQuery.aggregation ?? "value",
					unit: inferDisplayUnitForQuery(groupByQuery) ?? "number",
					align: "right",
				},
			],
		})
	},
}
