import { Option, Schema } from "effect"
import { WIDGET_TYPES } from "@maple/domain/http"
import { ProductEventsPathsWidgetParams } from "@maple/query-model"
import {
	PRODUCT_EVENTS_PATHS_ENDPOINT,
	dataSourceEndpoint,
	dataSourceRouteParams,
	makeProductEventsPathsDataSource,
	type ProductEventsPathsDefinition,
} from "@maple/widgets/dashboard"

import { BranchForkIcon } from "@/components/icons"
import { WidgetSettings } from "@/components/dashboard-builder/config/settings-fields"
import { PathsWidget } from "@/components/dashboard-builder/widgets/make-chart-widget"
import { pathsPresets } from "@/components/dashboard-builder/widgets/widget-definitions"
import {
	extendDisplay,
	type WidgetTypeDefinition,
} from "@/components/dashboard-builder/widgets/widget-type-registry"
import { chartPresetPreview } from "@/components/dashboard-builder/widgets/types/preset-preview"
import { DEFAULT_PATHS_DRAFT, type PathsWidgetDraft } from "@/lib/query-builder/widget-builder-shared"
import {
	compileFunnelStep,
	draftFromFunnelStep,
	formatProductEventsFilterClause,
	hasProductEventsFilters,
	parseProductEventsFilterClause,
} from "@/lib/query-builder/funnel-filters"
import { completedSteps } from "@/components/funnels/definition"

// The paths widget: one anchor, a direction, and how far and wide to walk.
// Like the product-event funnel it owns its data source outright — there is
// no query set behind it — so its definition lives on `display.paths` and is
// mirrored into the `product_events_paths` route params.

const parseExclude = (text: string): ReadonlyArray<string> =>
	text
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "")

export const pathsWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.paths,
	icon: BranchForkIcon,
	Renderer: PathsWidget,
	queryEditor: "paths",
	ConfigPanel: () => (
		<>
			<WidgetSettings.Divider />
			<WidgetSettings.QueryOptions />
		</>
	),
	presets: pathsPresets,
	PresetPreview: chartPresetPreview("query-builder-paths"),

	initialState: (widget) => {
		const stored = widget.display.paths
		const routeParams =
			dataSourceEndpoint(widget.dataSource) === PRODUCT_EVENTS_PATHS_ENDPOINT
				? Option.getOrUndefined(
						Schema.decodeUnknownOption(ProductEventsPathsWidgetParams)(
							dataSourceRouteParams(widget.dataSource) ?? {},
						),
					)
				: undefined
		const source = stored ?? routeParams
		if (!source) return { paths: DEFAULT_PATHS_DRAFT() }
		const keyBy = source.keyBy ?? "person"
		const windowSeconds = source.windowSeconds ?? 24 * 3600
		const include = source.include ?? "all"
		const exclude = source.exclude ?? []
		const paths: PathsWidgetDraft = {
			anchor: draftFromFunnelStep(source.anchor),
			direction: source.direction ?? "after",
			depth: source.depth ?? DEFAULT_PATHS_DRAFT().depth,
			branches: source.branches ?? DEFAULT_PATHS_DRAFT().branches,
			keyBy,
			windowSeconds,
			include,
			excludeText: exclude.join(", "),
			filterClause: formatProductEventsFilterClause(stored?.filters ?? routeParams),
			addOns: {
				keyBy: keyBy !== "person",
				window: windowSeconds !== 24 * 3600,
				include: include !== "all",
				exclude: exclude.length > 0,
			},
		}
		return { paths }
	},

	ownsDataSource: () => true,

	buildDataSource: ({ state, sharedTransform }) =>
		makeProductEventsPathsDataSource(pathsDefinition(state.paths), sharedTransform),

	buildDisplay: ({ base, state }) => {
		const { exclude, ...definition } = pathsDefinition(state.paths)
		// The stored display holds a mutable array; the definition a readonly one.
		return extendDisplay(base, {
			paths: { ...definition, ...(exclude ? { exclude: [...exclude] } : undefined) },
		})
	},

	validate: ({ state }) => {
		const { anchor, filterClause, windowSeconds, depth, branches } = state.paths
		if (completedSteps([anchor]).length === 0) return "The anchor needs an event name or page path"
		const compiled = compileFunnelStep(anchor)
		if (!compiled.ok) return compiled.error
		const filters = parseProductEventsFilterClause(filterClause)
		if (!filters.ok) return `Filters: ${filters.error}`
		if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return "The window must be positive"
		if (!Number.isInteger(depth) || depth < 1) return "Steps must be at least 1"
		if (!Number.isInteger(branches) || branches < 1) return "Branches must be at least 1"
		return null
	},
}

/** The draft lowered to the stored / routed definition. `validate` gates Apply, so a failed compile falls back to the bare step. */
function pathsDefinition(paths: PathsWidgetDraft): ProductEventsPathsDefinition {
	const compiled = compileFunnelStep(paths.anchor)
	const { filterClause: _clause, ...bare } = paths.anchor
	const anchor = compiled.ok ? compiled.value : bare
	const parsedFilters = parseProductEventsFilterClause(paths.filterClause)
	const filters =
		parsedFilters.ok && hasProductEventsFilters(parsedFilters.value) ? parsedFilters.value : undefined
	const exclude = parseExclude(paths.excludeText)
	return {
		// A session step cannot anchor a sequence; the panel never offers one.
		anchor: anchor.kind === "session" ? { kind: "event", eventName: "" } : anchor,
		direction: paths.direction,
		depth: paths.depth,
		branches: paths.branches,
		keyBy: paths.keyBy,
		windowSeconds: paths.windowSeconds,
		include: paths.include,
		...(exclude.length > 0 ? { exclude } : undefined),
		...(filters !== undefined ? { filters } : undefined),
	}
}
