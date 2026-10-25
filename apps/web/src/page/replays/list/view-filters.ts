import {
	asSessionTag,
	SESSION_TAG_DESCRIPTIONS,
	SESSION_TAG_DOTS,
	SESSION_TAG_LABELS,
	SESSION_TAG_ORDER,
} from "../../../components/replays/session-tags"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { type FilterOption, filterSection } from "../../../ui/filters/filter-section"
import * as FilterSections from "../../../ui/filters/filter-sections"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "../../../ui/filters/filter-sidebar"
import { type RangePreset, rangeFilterSection } from "../../../ui/filters/range-filter-section"
import { percentilePresets, toLogBuckets } from "../../../ui/filters/range-distribution"
import type { IconName } from "../../../ui/icon"
import { searchInput } from "../../../ui/search-input"
import { separator } from "../../../ui/display"
import { statusDot } from "../../../ui/status-dot"
import { browserIconFor, deviceIconFor } from "../kit/sessions-parts"
import { hasSidebarFilters, selectedTags } from "./derive"
import { type Facet, Message, type Range } from "./message"
import type { Model, ReplaysFacets } from "./model"

type FacetItem = ReplaysFacets["services"][number]

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

/** `withSelected`: a selected value missing from its own list stays checkable (count 0). */
const withSelected = (options: ReadonlyArray<FacetItem>, selected: string | undefined): ReadonlyArray<FilterOption> =>
	selected !== undefined && selected !== "" && !options.some((option) => option.name === selected)
		? [{ name: selected, count: 0 }, ...options]
		: options

const ACTIVE_TIME_PRESETS: ReadonlyArray<RangePreset> = [
	{ key: "idle", label: "Idle", value: "<5s", max: 5 },
	{ key: "active", label: "Active", value: ">30s", min: 30 },
]

const sessionLengthPresets = (p50Ms: number, p95Ms: number): ReadonlyArray<RangePreset> => [
	{ key: "bounced", label: "Bounced", value: "<10s", max: 10 },
	...percentilePresets(p50Ms / 1000, p95Ms / 1000, "s"),
]

const tagOptions = (facets: ReplaysFacets, selected: ReadonlyArray<string>): ReadonlyArray<FilterOption> => {
	const counted = SESSION_TAG_ORDER.map((tag) => ({
		name: tag,
		count: facets.tags.find((item) => item.name === tag)?.count ?? 0,
	})).filter((option) => option.count > 0)
	return selected.reduce<ReadonlyArray<FilterOption>>(
		(options, tag) => (options.some((option) => option.name === tag) ? options : [{ name: tag, count: 0 }, ...options]),
		counted,
	)
}

const tagLabel = (name: string) => {
	const tag = asSessionTag(name)
	return tag === undefined ? name : SESSION_TAG_LABELS[tag]
}

const singleSection = (
	h: HtmlBuilder<Message>,
	model: Model,
	title: string,
	facet: Facet,
	options: ReadonlyArray<FilterOption>,
	extra: Readonly<{ isSearchable?: boolean; getOptionIcon?: (name: string) => IconName }> = {},
) => {
	const value = model.search[facet]
	return filterSection(h, {
		title,
		options,
		selected: value === undefined || value === "" ? [] : [value],
		isSearchable: extra.isSearchable ?? true,
		getOptionIcon: extra.getOptionIcon,
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onToggle: (name) => Message.ToggledFacetOption({ facet, name }),
	})
}

const rangeSection = (
	h: HtmlBuilder<Message>,
	model: Model,
	range: Range,
	config: Readonly<{ title: string; hint?: string; presets: ReadonlyArray<RangePreset>; facets?: ReplaysFacets }>,
) => {
	const isDuration = range === "duration"
	const prefix = isDuration ? "replays-duration" : "replays-active"
	return rangeFilterSection(h, {
		title: config.title,
		hint: config.hint,
		unit: "s",
		minValue: isDuration ? model.search.durationMin : model.search.activeMin,
		maxValue: isDuration ? model.search.durationMax : model.search.activeMax,
		draft: isDuration ? model.durationDraft : model.activeDraft,
		presets: config.presets,
		histogram:
			config.facets === undefined
				? undefined
				: toLogBuckets(
						config.facets.durationBuckets.map((item) => ({ floor: Number(item.name) / 1000, count: item.count })),
						2,
					),
		histogramHover: model.histogramHover[range],
		onHistogram: (message) => Message.GotHistogramMessage({ range, message }),
		ids: { panel: `${prefix}-panel`, min: `${prefix}-min`, max: `${prefix}-max` },
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onDraftChange: (min, max) => Message.ChangedRangeDraft({ range, min, max }),
		onCommitDraft: Message.CommittedRangeDraft({ range }),
		onApply: (min, max) => Message.AppliedRange({ range, min, max }),
	})
}

/** `TextFilter`: identity is typed, committed on Enter; the × clears the applied filter. */
const textFilter = (
	h: HtmlBuilder<Message>,
	config: Readonly<{
		id: string
		key: string
		placeholder: string
		clearLabel: string
		value: string
		onInput: (value: string) => Message
		onSubmit: Message
		onClear: Message
	}>,
): Html =>
	h.form(
		[h.Key(config.key), h.Class("py-1"), h.OnSubmit(config.onSubmit)],
		[
			searchInput(h, {
				id: config.id,
				value: config.value,
				placeholder: config.placeholder,
				clearLabel: config.clearLabel,
				onInput: config.onInput,
				onClear: config.onClear,
				attributes: [h.AriaLabel(config.placeholder.replace("…", ""))],
			}),
		],
	)

const loadedRail = (h: HtmlBuilder<Message>, model: Model, facets: ReplaysFacets): Html => {
	const { search } = model
	const hasFilters = hasSidebarFilters(search)
	const tagsSelected = selectedTags(search)
	const tags = tagOptions(facets, tagsSelected)
	const lists = {
		services: withSelected(facets.services, search.service),
		browsers: withSelected(facets.browsers, search.browser),
		countries: withSelected(facets.countries, search.country),
		devices: withSelected(facets.devices, search.deviceType),
		groups: withSelected(facets.groups, search.group),
		pages: withSelected(facets.pages, search.page),
	}
	const hasFacets = Object.values(lists).some((list) => list.length > 0) || tags.length > 0 || facets.errorCount > 0
	if (!hasFacets && !hasFilters) return filterSidebarEmpty(h)
	return filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(model.facets.data) }, [
		filterSidebarHeader(h, hasFilters ? { onClear: Message.ClickedClearSidebarFilters() } : {}),
		...filterSidebarBody(h, "replays-filters", [
			filterSection(h, {
				title: "Session type",
				options: tags,
				selected: tagsSelected,
				getOptionLabel: tagLabel,
				getOptionDescription: (name) => {
					const tag = asSessionTag(name)
					return tag === undefined ? undefined : SESSION_TAG_DESCRIPTIONS[tag]
				},
				renderOptionIcon: (name) => {
					const tag = asSessionTag(name)
					return tag === undefined
						? undefined
						: statusDot(h, { tone: "custom", size: "lg", className: SESSION_TAG_DOTS[tag] })
				},
				sections: model.filterSections,
				toSectionsMessage: toSections,
				onToggle: (name) => Message.ToggledTag({ tag: name }),
			}),
			rangeSection(h, model, "duration", {
				title: "Session length",
				presets: sessionLengthPresets(facets.durationP50, facets.durationP95),
				facets,
			}),
			rangeSection(h, model, "active", { title: "Active time", hint: "Excludes idle gaps", presets: ACTIVE_TIME_PRESETS }),
			singleSection(h, model, "Page visited", "page", lists.pages),
			singleSection(h, model, "Service", "service", lists.services),
			singleSection(h, model, "Browser", "browser", lists.browsers, { getOptionIcon: browserIconFor }),
			singleSection(h, model, "Device", "deviceType", lists.devices, {
				isSearchable: false,
				getOptionIcon: deviceIconFor,
			}),
			singleSection(h, model, "Country", "country", lists.countries),
			lists.groups.length > 0 ? singleSection(h, model, "Group", "group", lists.groups) : null,
			separator(h, "horizontal", "my-2"),
			eyebrow(h, { as: "h4", variant: "label", className: "py-1" }, ["Identity"]),
			textFilter(h, {
				id: "replays-user-search",
				key: `user:${search.user ?? ""}`,
				placeholder: "Name or email…",
				clearLabel: "Clear name or email filter",
				value: model.userText,
				onInput: (value) => Message.ChangedUserText({ value }),
				onSubmit: Message.SubmittedUser(),
				onClear: Message.ClickedClearUser(),
			}),
			textFilter(h, {
				id: "replays-user-filter",
				key: `userId:${search.userId ?? ""}`,
				placeholder: "User ID…",
				clearLabel: "Clear user ID filter",
				value: model.userIdText,
				onInput: (value) => Message.ChangedUserIdText({ value }),
				onSubmit: Message.SubmittedUserId(),
				onClear: Message.ClickedClearUserId(),
			}),
		].filter((node): node is Html => node !== null)),
	])
}

export const filtersRail = (h: HtmlBuilder<Message>, model: Model): Html =>
	AsyncData.matchData(model.facets.data, {
		onEmpty: () => filterSidebarLoading(h, 5),
		onFailure: (failure) =>
			filterSidebarError(
				h,
				failure,
				Message.ClickedRetryList(),
				Option.getOrUndefined(AsyncData.getError(model.firstPage.data)),
			),
		onData: (facets) => loadedRail(h, model, facets),
	})
