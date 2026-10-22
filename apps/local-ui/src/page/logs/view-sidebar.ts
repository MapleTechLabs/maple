import { getServiceColor } from "@maple/ui/lib/colors"
import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { filterSection } from "@maple/web/ui/filters/filter-section"
import { filterSidebarBody, filterSidebarFrame, filterSidebarHeader } from "@maple/web/ui/filters/filter-sidebar"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Slot } from "../../data/slot"
import { activeFilterCount, type LogFilters } from "./filters"
import { Message } from "./message"
import type { FacetOption, Model } from "./model"
import { toSections } from "./update"

// The Logs page's filter rail.

const optionsOf = (slot: Slot<ReadonlyArray<FacetOption>>) =>
	Option.getOrElse(AsyncData.getData(slot.data), (): ReadonlyArray<FacetOption> => [])

const isFetching = (slot: Slot<unknown>) => AsyncData.isLoading(slot.data) || AsyncData.isRefreshing(slot.data)

const severityColor = (name: string): string | undefined =>
	Object.hasOwn(SEVERITY_COLORS, name) ? SEVERITY_COLORS[name] : undefined

export const sidebar = (h: HtmlBuilder<Message>, model: Model, filters: LogFilters): Html =>
	filterSidebarFrame(
		h,
		{ className: "w-56 shrink-0 px-4", isWaiting: isFetching(model.services) || isFetching(model.severities) },
		[
			filterSidebarHeader(h, activeFilterCount(filters) > 0 ? { onClear: Message.ClickedClearSidebarFilters() } : {}),
			...filterSidebarBody(
				h,
				"logs-filters",
				[
					filterSection(h, {
						title: "Severity",
						options: optionsOf(model.severities),
						selected: filters.severity ? [filters.severity] : [],
						colorOf: severityColor,
						sections: model.sections,
						toSectionsMessage: toSections,
						onToggle: (name) => Message.ToggledFacetOption({ param: "severity", name }),
					}),
					filterSection(h, {
						title: "Service",
						options: optionsOf(model.services),
						selected: filters.service ? [filters.service] : [],
						isSearchable: true,
						colorOf: getServiceColor,
						sections: model.sections,
						toSectionsMessage: toSections,
						onToggle: (name) => Message.ToggledFacetOption({ param: "service", name }),
					}),
				].filter((section) => section !== null),
			),
		],
	)
