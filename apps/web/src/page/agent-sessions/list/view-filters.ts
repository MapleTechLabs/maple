import type { AiSessionDistribution } from "@maple/domain/http"
import { getServiceColor } from "@maple/ui/lib/colors"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Checkbox from "../../../ui/checkbox"
import { filterDescriptionMark, filterSection } from "../../../ui/filters/filter-section"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
	filterSidebarDivider,
} from "../../../ui/filters/filter-sidebar"
import { percentilePresets, toLogBuckets } from "../../../ui/filters/range-distribution"
import { type RangePreset, rangeFilterSection } from "../../../ui/filters/range-filter-section"
import type { RangeUnit } from "../../../ui/filters/range-format"
import type { RangeBucket } from "../../../ui/filters/range-histogram"
import { label } from "../../../ui/label"
import { detectLookup } from "../kit/detected-models"
import { modelVendorColor, modelVendorIcon, vendorColor, vendorIcon, vendorLabel } from "../kit/vendor"
import { hasFilters, RANGE_PARAMS } from "./derive"
import { MountFilterRail } from "./command"
import { type ListFacet, Message } from "./message"
import type { Distributions, Facets, Model, RangeKey } from "./model"
import { RANGE_UNITS } from "./update"

// TODO(tooltip): the sections' description popovers are drawn as their closed info marks.

type H = HtmlBuilder<Message>

const QUICK_PRESET: RangePreset = { key: "quick", label: "Quick", value: "<10s", max: 10 }
const SINGLE_CALL_PRESET: RangePreset = { key: "single", label: "Single call", value: "1", min: 1, max: 1 }
const NO_TOOLS_PRESET: RangePreset = { key: "none", label: "No tools", value: "0", max: 0 }

/** One range section's histogram and presets (`distributionControls`). */
const distributionControls = (
	distribution: AiSessionDistribution | undefined,
	unit: RangeUnit,
	stepsPerOctave: number,
	intents: ReadonlyArray<RangePreset>,
	scale = 1,
): { histogram?: ReadonlyArray<RangeBucket>; presets: ReadonlyArray<RangePreset> } =>
	distribution === undefined
		? { presets: intents }
		: {
				histogram: toLogBuckets(
					distribution.buckets.map((bucket) => ({
						floor: bucket.floor * scale,
						count: bucket.count,
					})),
					stepsPerOctave,
				),
				presets: [
					...intents,
					...percentilePresets(distribution.p50 * scale, distribution.p95 * scale, unit),
				],
			}

const RANGES: ReadonlyArray<{
	range: RangeKey
	title: string
	hint?: string
	unitLabel?: string
	controls: (distributions: Distributions | undefined) => ReturnType<typeof distributionControls>
}> = [
	{
		range: "duration",
		title: "Session length",
		controls: (d) => distributionControls(d?.durationMs, "s", 2, [QUICK_PRESET], 1 / 1000),
	},
	{
		range: "cost",
		title: "Cost",
		hint: "As priced by the instrumentation",
		unitLabel: "priced sessions",
		controls: (d) => distributionControls(d?.cost, "usd", 2, []),
	},
	{
		range: "tokens",
		title: "Tokens",
		controls: (d) => distributionControls(d?.totalTokens, "count", 1, []),
	},
	{
		range: "llmCalls",
		title: "LLM calls",
		controls: (d) => distributionControls(d?.llmCalls, "count", 1, [SINGLE_CALL_PRESET]),
	},
	{
		range: "toolCalls",
		title: "Tool calls",
		unitLabel: "sessions with tools",
		controls: (d) => distributionControls(d?.toolCalls, "count", 1, [NO_TOOLS_PRESET]),
	},
]

const toSections = (message: Parameters<typeof Message.GotFilterSectionsMessage>[0]["message"]) =>
	Message.GotFilterSectionsMessage({ message })

const numberOrUndefined = (value: unknown): number | undefined =>
	typeof value === "number" ? value : undefined

const rangeSection = (
	h: H,
	model: Model,
	distributions: Distributions | undefined,
	spec: (typeof RANGES)[number],
) => {
	const [minKey, maxKey] = RANGE_PARAMS[spec.range]
	const { histogram, presets } = spec.controls(distributions)
	const ids = `agent-sessions-range-${spec.range}`
	return rangeFilterSection(h, {
		title: spec.title,
		hint: spec.hint,
		unit: RANGE_UNITS[spec.range],
		histogram,
		histogramUnitLabel: spec.unitLabel,
		histogramHover: model.histogramHover[spec.range],
		histogramDrag: model.histogramDrag[spec.range],
		onHistogram: (message) => Message.GotHistogramMessage({ range: spec.range, message }),
		minValue: numberOrUndefined(model.search[minKey]),
		maxValue: numberOrUndefined(model.search[maxKey]),
		draft: model.rangeDrafts[spec.range] ?? { min: "", max: "" },
		presets,
		ids: { panel: `${ids}-panel`, min: `${ids}-min`, max: `${ids}-max` },
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onDraftChange: (min, max) => Message.ChangedRangeDraft({ range: spec.range, min, max }),
		onCommitDraft: Message.CommittedRangeDraft({ range: spec.range }),
		onApply: (min, max) => Message.AppliedRange({ range: spec.range, min, max }),
	})
}

type FacetSpec = Readonly<{
	title: string
	facet: ListFacet
	isSearchable: boolean
	hasDescription: boolean
}>

const facetSection = (
	h: H,
	model: Model,
	spec: FacetSpec,
	options: Facets[ListFacet],
	extra: Partial<Parameters<typeof filterSection<Message>>[1]> = {},
): Html | null =>
	filterSection(h, {
		title: spec.title,
		options,
		selected: model.search[spec.facet] ?? [],
		isSearchable: spec.isSearchable,
		hasDescription: spec.hasDescription,
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onToggle: (name) => Message.ToggledFacetOption({ facet: spec.facet, name }),
		...extra,
	})

/** `SingleCheckboxFilter`. */
const singleCheckbox = (h: H, title: string, isChecked: boolean, onToggle: Message): Html => {
	const inputId = `filter-${title}`
	return h.div(
		[h.Class("flex items-center gap-2 py-1.5")],
		[
			...Checkbox.view(h, {
				model: { isChecked },
				toParentMessage: () => onToggle,
				id: `${inputId}-checkbox`,
				inputId,
			}),
			label(
				h,
				{
					className:
						"flex-1 min-w-0 flex items-center gap-1.5 cursor-pointer text-xs text-foreground font-normal sm:text-xs",
					attributes: [h.For(inputId), h.Id(Checkbox.labelId(inputId)), h.Title(title)],
				},
				[h.span([h.Class("truncate")], [title]), filterDescriptionMark(h, title)],
			),
		],
	)
}

const loadedRail = (h: H, model: Model, facets: Facets): Html => {
	const { search } = model
	const isFiltered = hasFilters(search)
	if (facets.vendors.length === 0 && facets.services.length === 0 && !isFiltered)
		return filterSidebarEmpty(h)
	const detect = detectLookup(model.detections)
	const distributions = Option.getOrUndefined(AsyncData.getData(model.distributions.data))
	return filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(model.facets.data) }, [
		filterSidebarHeader(h, isFiltered ? { onClear: Message.ClickedClearAllFilters() } : {}),
		...filterSidebarBody(h, "agent-sessions-filters", [
			facetSection(
				h,
				model,
				{ title: "Agent", facet: "agents", isSearchable: true, hasDescription: true },
				facets.agents,
			),
			facetSection(
				h,
				model,
				{ title: "Tool", facet: "tools", isSearchable: true, hasDescription: true },
				facets.tools,
			),
			facetSection(
				h,
				model,
				{ title: "Service", facet: "services", isSearchable: true, hasDescription: false },
				facets.services,
				{ colorOf: getServiceColor },
			),
			facetSection(
				h,
				model,
				{ title: "Framework", facet: "vendors", isSearchable: false, hasDescription: true },
				facets.vendors,
				{ getOptionLabel: vendorLabel, getOptionIcon: vendorIcon, getOptionIconColor: vendorColor },
			),
			facetSection(
				h,
				model,
				{ title: "Model", facet: "models", isSearchable: true, hasDescription: true },
				facets.models,
				{
					getOptionLabel: (name) => detect(name).displayName,
					getOptionIcon: (name) => modelVendorIcon(detect(name)),
					getOptionIconColor: (name) => modelVendorColor(detect(name)),
				},
			),
			facetSection(
				h,
				model,
				{ title: "Environment", facet: "environments", isSearchable: false, hasDescription: false },
				facets.environments,
			),
			filterSidebarDivider(h),
			...RANGES.map((spec) => rangeSection(h, model, distributions, spec)),
			filterSidebarDivider(h),
			singleCheckbox(
				h,
				"Hide single-trace sessions",
				search.grouped === true,
				Message.ToggledGrouped(),
			),
		]),
	])
}

/** `AgentSessionsFilterSidebar`; its Mount starts the rail's model detection. */
export const filtersRail = (h: H, model: Model): Html =>
	h.div(
		[h.Class("contents"), h.OnMount(MountFilterRail())],
		[
			AsyncData.matchData(model.facets.data, {
				onEmpty: () => filterSidebarLoading(h, 4),
				onFailure: (failure) =>
					filterSidebarError(h, failure, undefined, Option.getOrUndefined(AsyncData.getError(model.firstPage.data))),
				onData: (facets) => loadedRail(h, model, facets),
			}),
		],
	)
