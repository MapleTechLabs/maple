import { WEB_ANALYTICS_UNSET } from "@maple/domain/query-engine"
import { FILTER_SECTION_LABEL, hasActiveFilters, trafficIncludes } from "../../components/analytics/filters"
import { countryLabel, languageLabel, referrerLabel, utmLabel } from "../../components/analytics/labels"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { separator } from "../../ui/display"
import { eyebrow } from "../../ui/eyebrow"
import { type FilterOption, filterSection, singleCheckboxFilter } from "../../ui/filters/filter-section"
import * as FilterSections from "../../ui/filters/filter-sections"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "../../ui/filters/filter-sidebar"
import { icon, type IconName } from "../../ui/icon"
import { browserIconFor, deviceIconFor } from "../replays/kit/sessions-parts"
import { type FilterKey, Message } from "./message"
import type { Breakdowns, Model } from "./model"
import { filtersOf } from "./requests"
import { favicon, isHostLike } from "./view-icons"

// `AnalyticsFilterSidebar`: the page's filter rail.

type H = HtmlBuilder<Message>

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const section = (
	h: H,
	model: Model,
	key: FilterKey,
	options: ReadonlyArray<FilterOption>,
	extra: Readonly<{
		isSearchable?: boolean
		getOptionLabel?: (name: string) => string
		getOptionIcon?: (name: string) => IconName
		renderOptionIcon?: (name: string) => Html | undefined
	}> = {},
) => {
	const value = filtersOf(model.search)[key]
	return filterSection(h, {
		title: FILTER_SECTION_LABEL[key],
		options,
		selected: value === undefined ? [] : [value],
		isSearchable: extra.isSearchable ?? true,
		getOptionLabel: extra.getOptionLabel,
		getOptionIcon: extra.getOptionIcon,
		renderOptionIcon: extra.renderOptionIcon,
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onToggle: (name) => Message.ToggledFilter({ key, value: name }),
	})
}

const checkboxGroup = (h: H, title: string, children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("py-1")],
		[eyebrow(h, { as: "h4", variant: "label", className: "py-1" }, [title]), ...children],
	)

const loadedRail = (h: H, model: Model, breakdowns: Breakdowns): Html => {
	const filters = filtersOf(model.search)
	const canClear = hasActiveFilters(filters)
	const isEmpty = Object.values(breakdowns).every((rows) => rows.length === 0)
	if (!canClear && isEmpty) return filterSidebarEmpty(h)
	const events = Option.getOrElse(AsyncData.getData(model.events.data), () => [])
	const hostIcon = (name: string) => favicon(h, model, name, "size-3.5")
	return filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(model.breakdowns.data) }, [
		filterSidebarHeader(h, canClear ? { onClear: Message.ClickedClearFilters() } : {}),
		...filterSidebarBody(
			h,
			"analytics-filters",
			[
				checkboxGroup(h, FILTER_SECTION_LABEL.traffic, [
					singleCheckboxFilter(h, {
						title: "Humans",
						isChecked: trafficIncludes(filters.traffic, "humans"),
						onToggle: Message.ToggledTraffic({
							which: "humans",
							isOn: !trafficIncludes(filters.traffic, "humans"),
						}),
					}),
					singleCheckboxFilter(h, {
						title: "Bots",
						isChecked: trafficIncludes(filters.traffic, "bots"),
						onToggle: Message.ToggledTraffic({
							which: "bots",
							isOn: !trafficIncludes(filters.traffic, "bots"),
						}),
					}),
				]),
				separator(h, "horizontal", "my-1"),
				section(h, model, "host", breakdowns.hosts, { renderOptionIcon: hostIcon }),
				section(h, model, "pagePath", breakdowns.entryPaths),
				events.length > 0 || filters.eventName !== undefined
					? section(
							h,
							model,
							"eventName",
							events.map((event) => ({ name: event.name, count: event.sessions })),
						)
					: null,
				separator(h, "horizontal", "my-1"),
				section(h, model, "referrerHost", breakdowns.referrerHosts, {
					getOptionLabel: referrerLabel,
					renderOptionIcon: (name) =>
						name === WEB_ANALYTICS_UNSET
							? icon(h, "ArrowThroughLineRightIcon", {
									className: "size-3.5 shrink-0 text-foreground",
								})
							: hostIcon(name),
				}),
				section(h, model, "utmSource", breakdowns.utmSources, {
					getOptionLabel: utmLabel,
					renderOptionIcon: (name) => (isHostLike(name) ? hostIcon(name) : undefined),
				}),
				section(h, model, "utmMedium", breakdowns.utmMediums, {
					isSearchable: false,
					getOptionLabel: utmLabel,
				}),
				section(h, model, "utmCampaign", breakdowns.utmCampaigns, { getOptionLabel: utmLabel }),
				separator(h, "horizontal", "my-1"),
				checkboxGroup(h, FILTER_SECTION_LABEL.visitorType, [
					singleCheckboxFilter(h, {
						title: "New",
						isChecked: filters.visitorType === "new",
						onToggle: Message.ChangedFilter({
							key: "visitorType",
							value: filters.visitorType === "new" ? undefined : "new",
						}),
					}),
					singleCheckboxFilter(h, {
						title: "Returning",
						isChecked: filters.visitorType === "returning",
						onToggle: Message.ChangedFilter({
							key: "visitorType",
							value: filters.visitorType === "returning" ? undefined : "returning",
						}),
					}),
				]),
				section(h, model, "country", breakdowns.countries, { getOptionLabel: countryLabel }),
				section(h, model, "language", breakdowns.languages, { getOptionLabel: languageLabel }),
				separator(h, "horizontal", "my-1"),
				section(h, model, "deviceType", breakdowns.deviceTypes, {
					isSearchable: false,
					getOptionIcon: deviceIconFor,
				}),
				section(h, model, "browserName", breakdowns.browsers, {
					isSearchable: false,
					getOptionIcon: browserIconFor,
				}),
				section(h, model, "osName", breakdowns.operatingSystems, { isSearchable: false }),
			].filter((node): node is Html => node !== null),
		),
	])
}

export const filtersRail = (h: H, model: Model): Html =>
	AsyncData.matchData(model.breakdowns.data, {
		onEmpty: () => filterSidebarLoading(h, 6),
		onFailure: (failure) => filterSidebarError(h, failure),
		onData: (breakdowns) => loadedRail(h, model, breakdowns),
	})
