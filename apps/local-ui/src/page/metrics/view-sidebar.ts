import { getServiceColor } from "@maple/ui/lib/colors"
import { METRIC_TYPE_COLORS } from "@maple/web/page/metrics/shared"
import { filterSection } from "@maple/web/ui/filters/filter-section"
import type * as FilterSections from "@maple/web/ui/filters/filter-sections"
import {
	filterSidebarBody,
	filterSidebarFrame,
	filterSidebarHeader,
} from "@maple/web/ui/filters/filter-sidebar"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "./message"
import type { Model } from "./model"

// The Metrics page's filter rail.

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

/** copied: `metricTypeLabel` (packages/ui/src/components/metrics/metric-type-badge.tsx). */
const TYPE_LABELS = new Map([
	["sum", "Sum"],
	["gauge", "Gauge"],
	["histogram", "Histogram"],
])
export const metricTypeLabel = (type: string): string =>
	type === "exponential_histogram" ? "Exp histogram" : (TYPE_LABELS.get(type) ?? type)

export const sidebar = (
	h: HtmlBuilder<Message>,
	model: Model,
	filters: Readonly<{ service?: string; type?: string }>,
	activeFilterCount: number,
): Html => {
	const summary = Option.getOrElse(AsyncData.getData(model.summary.data), () => [])
	// A stable sort: equal counts keep the summary's order.
	const typeFacets = summary
		.map((row) => ({ name: row.metricType, count: row.metricCount }))
		.toSorted((a, b) => b.count - a.count)
	const serviceFacets = Option.match(AsyncData.getData(model.list.data), {
		onNone: () => [],
		onSome: (data) => data.serviceFacets,
	})
	const isFetching = AsyncData.isLoading(model.list.data) || AsyncData.isRefreshing(model.list.data)
	const sections = [
		filterSection(h, {
			title: "Type",
			options: typeFacets,
			selected: filters.type ? [filters.type] : [],
			sections: model.sections,
			toSectionsMessage: toSections,
			onToggle: (name) => Message.ToggledFacetOption({ param: "type", name }),
			getOptionLabel: metricTypeLabel,
			colorOf: (name) => METRIC_TYPE_COLORS.get(name),
		}),
		filterSection(h, {
			title: "Service",
			options: serviceFacets,
			selected: filters.service ? [filters.service] : [],
			isSearchable: true,
			sections: model.sections,
			toSectionsMessage: toSections,
			onToggle: (name) => Message.ToggledFacetOption({ param: "service", name }),
			colorOf: getServiceColor,
		}),
	]
	return filterSidebarFrame(h, { className: "w-56 shrink-0 px-4", isWaiting: isFetching }, [
		filterSidebarHeader(
			h,
			activeFilterCount > 0 ? { onClear: Message.ClickedClearSidebarFilters() } : {},
		),
		...filterSidebarBody(
			h,
			"metrics-filters",
			sections.filter((section) => section !== null),
		),
	])
}
