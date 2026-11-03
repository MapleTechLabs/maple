import { WEB_ANALYTICS_UNSET } from "@maple/domain/query-engine"
import { cn } from "@maple/ui/lib/utils"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "@maple/views/data/load-failure"
import {
	type FilterOption,
	filterSection,
	singleCheckboxFilter,
} from "@maple/views/ui/filters/filter-section"
import type * as FilterSections from "@maple/views/ui/filters/filter-sections"
import {
	filterSidebarBody,
	filterSidebarDivider,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarGroupLabel,
	filterSidebarHeader,
	filterSidebarLoading,
} from "@maple/views/ui/filters/filter-sidebar"
import { icon, type IconName } from "@maple/views/ui/icon"
import {
	type AnalyticsFilterKey,
	type AnalyticsFilters,
	FILTER_SECTION_LABEL,
	hasActiveFilters,
	trafficIncludes,
} from "../../components/analytics/filters"
import { countryLabel, languageLabel, referrerLabel, utmLabel } from "../../components/analytics/labels"
import { browserIconFor, deviceIconFor } from "../replays/kit/sessions-parts"

// `AnalyticsFilterSidebar`: the session-dimension filter rail of /analytics and /product-analytics,
// its options from `getWebAnalyticsBreakdowns`. Every filter is one value in the page's URL.

const FacetRow = Schema.Struct({ name: Schema.String, count: Schema.Number })

/** `WebAnalyticsBreakdowns`. */
export const Breakdowns = Schema.Struct({
	referrerHosts: Schema.Array(FacetRow),
	countries: Schema.Array(FacetRow),
	deviceTypes: Schema.Array(FacetRow),
	browsers: Schema.Array(FacetRow),
	operatingSystems: Schema.Array(FacetRow),
	languages: Schema.Array(FacetRow),
	utmSources: Schema.Array(FacetRow),
	utmMediums: Schema.Array(FacetRow),
	utmCampaigns: Schema.Array(FacetRow),
	entryPaths: Schema.Array(FacetRow),
	exitPaths: Schema.Array(FacetRow),
	hosts: Schema.Array(FacetRow),
})
export type Breakdowns = typeof Breakdowns.Type

const ICON_BOX = "size-4 shrink-0"

const faviconUrl = (host: string): string => `https://favicon.maple.dev/?url=${encodeURIComponent(host)}`

/** `isHostLike`: a dotted name a favicon could exist for. */
export const isHostLike = (value: string): boolean => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)

/** `Favicon`: the site's icon, or its reserved box once the image failed. */
export const favicon = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ failed: ReadonlyArray<string>; onFailed: (host: string) => M }>,
	host: string,
	className?: string,
): Html =>
	options.failed.includes(host)
		? h.span([h.Class(cn(ICON_BOX, className)), h.AriaHidden(true)], [])
		: h.img([
				h.Src(faviconUrl(host)),
				h.Alt(""),
				h.AriaHidden(true),
				h.Loading("lazy"),
				h.Decoding("async"),
				h.Referrerpolicy("no-referrer"),
				h.OnError(options.onFailed(host)),
				h.Class(cn(ICON_BOX, "rounded-xs object-contain", className)),
			])

export type AnalyticsFilterRailOptions<M> = Readonly<{
	/** The sidebar body's scroll slot, unique per page. */
	id: string
	breakdowns: AsyncData.AsyncData<Breakdowns, LoadFailure>
	filters: AnalyticsFilters
	/** The Event section's options; without them the section is left out. */
	events?: ReadonlyArray<FilterOption>
	/** The Humans/Bots group; product events have no bot split, so that page leaves it out. */
	traffic?: Readonly<{ onToggle: (which: "humans" | "bots", isOn: boolean) => M }>
	/** The page already shows this read's failure in full; the rail only points at it. */
	showsFailureElsewhere: boolean
	sections: FilterSections.Model
	failedFavicons: ReadonlyArray<string>
	onSections: (message: FilterSections.Message) => M
	onToggle: (key: AnalyticsFilterKey, value: string) => M
	onChange: (key: AnalyticsFilterKey, value: string | undefined) => M
	onClear: M
	onFaviconFailed: (host: string) => M
}>

const loadedRail = <M>(
	h: HtmlBuilder<M>,
	options: AnalyticsFilterRailOptions<M>,
	breakdowns: Breakdowns,
): Html => {
	const { filters } = options
	const canClear = hasActiveFilters(filters)
	const isEmpty = Object.values(breakdowns).every((rows) => rows.length === 0)
	if (!canClear && isEmpty) return filterSidebarEmpty(h)
	const icons = { failed: options.failedFavicons, onFailed: options.onFaviconFailed }
	const hostIcon = (name: string) => favicon(h, icons, name, "size-3.5")
	const section = (
		key: AnalyticsFilterKey,
		items: ReadonlyArray<FilterOption>,
		extra: Readonly<{
			isSearchable?: boolean
			getOptionLabel?: (name: string) => string
			getOptionIcon?: (name: string) => IconName
			renderOptionIcon?: (name: string) => Html | undefined
		}> = {},
	): Html => {
		const value = filters[key]
		return filterSection(h, {
			title: FILTER_SECTION_LABEL[key],
			options: items,
			selected: value === undefined ? [] : [value],
			isSearchable: extra.isSearchable ?? true,
			getOptionLabel: extra.getOptionLabel,
			getOptionIcon: extra.getOptionIcon,
			renderOptionIcon: extra.renderOptionIcon,
			sections: options.sections,
			toSectionsMessage: options.onSections,
			onToggle: (name) => options.onToggle(key, name),
		})
	}
	const checkboxGroup = (title: string, children: ReadonlyArray<Html>): Html =>
		h.div([h.Class("pb-3")], [filterSidebarGroupLabel(h, title), ...children])
	const visitorType = (value: "new" | "returning", title: string): Html =>
		singleCheckboxFilter(h, {
			title,
			isChecked: filters.visitorType === value,
			onToggle: options.onChange("visitorType", filters.visitorType === value ? undefined : value),
		})
	const trafficToggle = (
		onToggle: (which: "humans" | "bots", isOn: boolean) => M,
		which: "humans" | "bots",
		title: string,
	): Html =>
		singleCheckboxFilter(h, {
			title,
			isChecked: trafficIncludes(filters.traffic, which),
			onToggle: onToggle(which, !trafficIncludes(filters.traffic, which)),
		})
	const { events, traffic } = options
	return filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(options.breakdowns) }, [
		filterSidebarHeader(h, canClear ? { onClear: options.onClear } : {}),
		...filterSidebarBody(h, options.id, [
			...(traffic !== undefined
				? [
						checkboxGroup(FILTER_SECTION_LABEL.traffic, [
							trafficToggle(traffic.onToggle, "humans", "Humans"),
							trafficToggle(traffic.onToggle, "bots", "Bots"),
						]),
						filterSidebarDivider(h),
					]
				: []),
			section("host", breakdowns.hosts, { renderOptionIcon: hostIcon }),
			section("pagePath", breakdowns.entryPaths),
			...(events !== undefined && (events.length > 0 || filters.eventName !== undefined)
				? [section("eventName", events)]
				: []),
			filterSidebarDivider(h),
			section("referrerHost", breakdowns.referrerHosts, {
				getOptionLabel: referrerLabel,
				renderOptionIcon: (name) =>
					name === WEB_ANALYTICS_UNSET
						? icon(h, "ArrowThroughLineRightIcon", {
								className: "size-3.5 shrink-0 text-foreground",
							})
						: hostIcon(name),
			}),
			section("utmSource", breakdowns.utmSources, {
				getOptionLabel: utmLabel,
				renderOptionIcon: (name) => (isHostLike(name) ? hostIcon(name) : undefined),
			}),
			section("utmMedium", breakdowns.utmMediums, { isSearchable: false, getOptionLabel: utmLabel }),
			section("utmCampaign", breakdowns.utmCampaigns, { getOptionLabel: utmLabel }),
			filterSidebarDivider(h),
			checkboxGroup(FILTER_SECTION_LABEL.visitorType, [
				visitorType("new", "New"),
				visitorType("returning", "Returning"),
			]),
			section("country", breakdowns.countries, { getOptionLabel: countryLabel }),
			section("language", breakdowns.languages, { getOptionLabel: languageLabel }),
			filterSidebarDivider(h),
			section("deviceType", breakdowns.deviceTypes, {
				isSearchable: false,
				getOptionIcon: deviceIconFor,
			}),
			section("browserName", breakdowns.browsers, {
				isSearchable: false,
				getOptionIcon: browserIconFor,
			}),
			section("osName", breakdowns.operatingSystems, { isSearchable: false }),
		]),
	])
}

/** `AnalyticsFilterSidebar`: loading rows, the read's failure, or a section per session dimension. */
export const analyticsFilterRail = <M>(h: HtmlBuilder<M>, options: AnalyticsFilterRailOptions<M>): Html =>
	AsyncData.matchData(options.breakdowns, {
		onEmpty: () => filterSidebarLoading(h, 6),
		onFailure: (failure) =>
			filterSidebarError(h, failure, undefined, options.showsFailureElsewhere ? failure : undefined),
		onData: (breakdowns) => loadedRail(h, options, breakdowns),
	})
