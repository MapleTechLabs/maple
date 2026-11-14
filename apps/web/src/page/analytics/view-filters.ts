import { activeFilterChips, FILTER_SECTION_LABEL } from "./filters"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { filterSection } from "@maple/views/ui/filters/filter-section"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "@maple/views/ui/filters/filter-sidebar"
import { presenceOf } from "@maple/views/data/signal-presence"
import { analyticsFilterRail } from "../kit/analytics-filter-rail"
import { Message } from "./message"
import type { Model } from "./model"
import { filtersOf, searchSiteOf, tabOf } from "./requests"

// The page's filter rail: the kit's, with the Traffic group and the Event section.

type H = HtmlBuilder<Message>

/** The overview's breakdown cards render (not the AI tab, not the no-sessions setup state). */
export const showsBreakdownCards = (model: Model): boolean =>
	tabOf(model.search) === "overview" &&
	!(
		presenceOf(model.presence, "sessions").status === "absent" &&
		activeFilterChips(filtersOf(model.search)).length === 0
	)

// The breakdown cards show this same read's failure in full; when they are not drawn, the rail explains it.
export const filtersRail = (h: H, model: Model): Html =>
	analyticsFilterRail(h, {
		id: "analytics-filters",
		breakdowns: model.breakdowns.data,
		filters: filtersOf(model.search),
		events: Arr.map(
			Option.getOrElse(AsyncData.getData(model.events.data), () => []),
			(event) => ({ name: event.name, count: event.sessions }),
		),
		showsFailureElsewhere: showsBreakdownCards(model),
		sections: model.filterSections,
		failedFavicons: model.failedFavicons,
		onSections: (message) => Message.GotFilterSectionsMessage({ message }),
		onToggle: (key, value) => Message.ToggledFilter({ key, value }),
		onChange: (key, value) => Message.ChangedFilter({ key, value }),
		traffic: { onToggle: (which, isOn) => Message.ToggledTraffic({ which, isOn }) },
		onClear: Message.ClickedClearFilters(),
		onFaviconFailed: (host) => Message.FailedFavicon({ host }),
	})

/**
 * The Search tab's rail: only the event filter applies there, as the Pages table's conversion.
 * It arrives with the tables, once the status names an imported property: until then there is
 * nothing to filter, and a rail that flashes in and out moves the whole page.
 */
export const searchEventRail = (h: H, model: Model): Html | undefined => {
	const status = Option.getOrUndefined(AsyncData.getData(model.searchStatus.data))
	const site = searchSiteOf(model.search, status)
	if (site === undefined || site.watermarkDate === null) return undefined
	const eventName = filtersOf(model.search).eventName
	// No Search panel shows this read, so the rail carries its failure and the retry.
	if (AsyncData.isFailure(model.events.data))
		return Option.match(AsyncData.getError(model.events.data), {
			onNone: () => filterSidebarEmpty(h),
			onSome: (failure) => filterSidebarError(h, failure, Message.ClickedRetryEvents()),
		})
	const events = Option.getOrElse(AsyncData.getData(model.events.data), () => [])
	if (events.length === 0 && eventName === undefined)
		return AsyncData.isLoading(model.events.data) ? filterSidebarLoading(h, 1) : filterSidebarEmpty(h)
	return filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(model.events.data) }, [
		filterSidebarHeader(
			h,
			eventName === undefined
				? {}
				: { onClear: Message.ChangedFilter({ key: "eventName", value: undefined }) },
		),
		...filterSidebarBody(h, "analytics-search-filters", [
			filterSection(h, {
				title: FILTER_SECTION_LABEL.eventName,
				options: Arr.map(events, (event) => ({ name: event.name, count: event.sessions })),
				selected: eventName === undefined ? [] : [eventName],
				isSearchable: true,
				sections: model.filterSections,
				toSectionsMessage: (message) => Message.GotFilterSectionsMessage({ message }),
				onToggle: (name) => Message.ToggledFilter({ key: "eventName", value: name }),
			}),
		]),
	])
}
