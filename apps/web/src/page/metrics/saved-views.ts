import { AppRoute, hrefOf } from "../../route"
import { MetricSearch, MetricsSearch } from "../../route/search"
import { lastBy } from "../kit/last-by"
import * as SavedViews from "../kit/saved-views"

// The metrics explorer as its Views control reads it. `/metrics` and a metric's own page share one
// list: a view saved on a metric's page carries the metric and opens that page.

const viewHref = SavedViews.memoHref((state) =>
	state.metricName === undefined
		? hrefOf(AppRoute.Metrics({ search: SavedViews.readSearch(MetricsSearch, state.search, {}) }))
		: hrefOf(
				AppRoute.Metric({
					metricName: state.metricName,
					search: SavedViews.readSearch(MetricSearch, state.search, {}),
				}),
			),
)

/** `/metrics`: rebuilt only when the URL search changes. */
export const browseViewsExplorer = lastBy(
	([search]: readonly [typeof MetricsSearch.Type]): SavedViews.Explorer => ({
		surface: "metrics",
		current: { search: SavedViews.searchParamsOf(search) },
		hrefOf: viewHref,
	}),
)

/** A metric's page: the metric is part of the view. */
export const metricViewsExplorer = lastBy(
	([metricName, search]: readonly [string, typeof MetricSearch.Type]): SavedViews.Explorer => ({
		surface: "metrics",
		current: { search: SavedViews.searchParamsOf(search), metricName },
		hrefOf: viewHref,
	}),
)
