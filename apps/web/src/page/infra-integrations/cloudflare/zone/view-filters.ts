import { CACHE_STATUS_COLORS, STATUS_CLASS_COLORS } from "../../../../components/infra/cloudflare/constants"
import {
	activeFilterChips,
	type CloudflareFilters,
	hasActiveFilters,
} from "../../../../components/infra/cloudflare/filters"
import { cn } from "@maple/ui/lib/utils"
import { buttonVariants } from "@maple/ui/styles/ui/button"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as FilterSections from "../../../../ui/filters/filter-sections"
import { type FilterOption, filterSection } from "../../../../ui/filters/filter-section"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "../../../../ui/filters/filter-sidebar"
import * as Popover from "../../../../ui/popover"
import { filterChipRail } from "../../kit/filter-chip-rail"
import type { ZoneFacets } from "../data"
import { type FilterKey, Message, type Model } from "./model"

// `CloudflareFilterChips`, `CloudflareFilterPopover` and `CloudflareFilterSidebarView`.

type H = HtmlBuilder<Message>

export const filterChips = (h: H, model: Model, filters: CloudflareFilters): Html | null =>
	filterChipRail(h, {
		chips: activeFilterChips(filters),
		onRemove: (chip) => Message.RemovedFilterChip({ key: chip.key, value: chip.value }),
		onClear: Message.ClickedClearFilters(),
		isExpanded: model.areChipsExpanded,
		onExpand: Message.ClickedExpandChips(),
	})

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const colorFrom = (map: Readonly<Record<string, string>>) => (name: string) =>
	Object.hasOwn(map, name) ? map[name] : undefined

type SectionSpec = Readonly<{
	title: string
	key: Exclude<FilterKey, "pathContains">
	options: ReadonlyArray<FilterOption>
	isSearchable?: boolean
	defaultOpen?: boolean
	colorOf?: (name: string) => string | undefined
	getOptionLabel?: (name: string) => string
}>

const sidebar = (h: H, model: Model, filters: CloudflareFilters): Html => {
	const body = (response: ZoneFacets, isWaiting: boolean): Html => {
		const f = response.data
		const hasFilters = hasActiveFilters(filters)
		if (!hasFilters && Object.values(f).every((options) => options.length === 0))
			return filterSidebarEmpty(h)
		const sections: ReadonlyArray<SectionSpec> = [
			{ title: "Path", key: "paths", options: f.paths, isSearchable: true, defaultOpen: true },
			{ title: "Host", key: "hosts", options: f.hosts, isSearchable: true, defaultOpen: true },
			{
				title: "Status class",
				key: "statusClasses",
				options: f.statusClasses,
				colorOf: colorFrom(STATUS_CLASS_COLORS),
			},
			{
				title: "Cache status",
				key: "cacheStatuses",
				options: f.cacheStatuses,
				colorOf: colorFrom(CACHE_STATUS_COLORS),
			},
			{
				title: "Country",
				key: "countries",
				options: f.countries,
				isSearchable: true,
				defaultOpen: false,
			},
			{ title: "Method", key: "methods", options: f.methods, defaultOpen: false },
			{
				title: "Protocol",
				key: "protocols",
				options: f.protocols,
				defaultOpen: false,
				getOptionLabel: (name) => (name === "unknown" ? name : `HTTP/${name}`),
			},
			{ title: "Device", key: "deviceTypes", options: f.deviceTypes, defaultOpen: false },
		]
		return filterSidebarFrame(h, { isWaiting }, [
			filterSidebarHeader(h, hasFilters ? { onClear: Message.ClickedClearFilters() } : {}),
			...filterSidebarBody(
				h,
				"cloudflare-zone-filters",
				sections.flatMap((spec) => {
					const section = filterSection(h, {
						title: spec.title,
						options: spec.options,
						selected: filters[spec.key] ?? [],
						isSearchable: spec.isSearchable,
						defaultOpen: spec.defaultOpen,
						sections: model.filterSections,
						toSectionsMessage: toSections,
						onToggle: (name) => Message.ToggledFilter({ key: spec.key, value: name }),
						colorOf: spec.colorOf,
						getOptionLabel: spec.getOptionLabel,
					})
					return section === null ? [] : [section]
				}),
			),
		])
	}
	// Only the traffic tab draws the detail read's error panel; elsewhere the rail must explain it.
	const mainFailure =
		(model.search.tab ?? "traffic") === "traffic"
			? Option.getOrUndefined(AsyncData.getError(model.detail.data))
			: undefined
	return AsyncData.match(model.facets.data, {
		onIdle: () => filterSidebarLoading(h, 6),
		onLoading: () => filterSidebarLoading(h, 6),
		onFailure: (failure) => filterSidebarError(h, failure, undefined, mainFailure),
		onStale: ({ error }) => filterSidebarError(h, error, undefined, mainFailure),
		onSuccess: (response) => body(response, false),
		onRefreshing: (response) => body(response, true),
	})
}

/** `CloudflareFilterPopover`: every facet behind one dashed button. */
export const filterPopover = (h: H, model: Model, filters: CloudflareFilters): Html =>
	h.submodel({
		slotId: "cloudflare-zone-filter-popover",
		model: model.filterPopover,
		view: Popover.view,
		toParentMessage: (message: Popover.Message) => Message.GotFilterPopoverMessage({ message }),
		viewInputs: {
			className: "max-h-[70vh] w-72 overflow-y-auto p-0",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						h.button(
							[
								h.Type("button"),
								h.DataAttribute("slot", "button"),
								h.Class(
									cn(
										buttonVariants({
											variant: "outline",
											size: "xs",
											className: "h-6 border-dashed font-mono text-2xs font-normal",
										}),
									),
								),
								...trigger,
							],
							["+ Filter"],
						),
					),
				),
			toContent: () => [sidebar(h, model, filters)],
		},
	})
