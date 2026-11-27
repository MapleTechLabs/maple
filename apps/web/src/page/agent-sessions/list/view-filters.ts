import type { AiEvaluatorSummary, AiSessionDistribution } from "@maple/domain/http"
import { getServiceColor } from "@maple/ui/lib/colors"
import { Option, Order, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Checkbox from "@maple/views/ui/checkbox"
import { filterDescriptionMark, filterSection } from "@maple/views/ui/filters/filter-section"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
	filterSidebarDivider,
} from "@maple/views/ui/filters/filter-sidebar"
import { percentilePresets, toLogBuckets } from "@maple/views/ui/filters/range-distribution"
import { type RangePreset, rangeFilterSection } from "@maple/views/ui/filters/range-filter-section"
import type { RangeUnit } from "@maple/views/ui/filters/range-format"
import type { RangeBucket } from "@maple/views/ui/filters/range-histogram"
import { label } from "@maple/views/ui/label"
import { detectLookup } from "../kit/detected-models"
import {
	modelVendorColor,
	modelVendorIcon,
	vendorColor,
	vendorIcon,
	vendorLabel,
} from "@maple/views/lib/ai-vendor"
import {
	evaluationOf,
	evaluationOptionKey,
	hasFilters,
	parseEvaluationOptionKey,
	RANGE_PARAMS,
} from "./derive"
import { MountFilterRail } from "./command"
import { type ListFacet, Message } from "./message"
import type { Distributions, Facets, Model, RangeKey } from "./model"
import { RANGE_UNITS } from "./update"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

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
					Arr.map(distribution.buckets, (bucket) => ({
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
	description?: string
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
		description: "As priced by the instrumentation.",
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
		description: spec.description,
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
	description?: string
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
		description: spec.description,
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onToggle: (name) => Message.ToggledFacetOption({ facet: spec.facet, name }),
		...extra,
	})

const singleCheckbox = (
	h: H,
	title: string,
	description: string,
	isChecked: boolean,
	onToggle: Message,
): Html => {
	const inputId = `filter-${title}`
	return hstack(h, { gap: "2", align: "center", className: "py-1.5" }, [
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
				attributes: [h.For(inputId), h.Id(Checkbox.labelId(inputId))],
			},
			// The title on the text only, so the info mark's tooltip is the one it shows.
			[
				typography(h, { truncate: true, attributes: [h.Title(title)] }, [title]),
				filterDescriptionMark(h, title, description),
			],
		),
	])
}

/** Maple's own session checks: listed after the org's evaluators, which they would crowd out. */
const isSessionCheck = (evaluator: { readonly sources: ReadonlyArray<string> }) =>
	Arr.contains(evaluator.sources, "maple_check")

/** The evaluation score options: each evaluator once per verdict it gave, counted in scores. */
const evaluationOptions = (model: Model) => {
	const evaluators: ReadonlyArray<AiEvaluatorSummary> = Arr.sort(
		Option.getOrElse(AsyncData.getData(model.evaluators.data), () => []),
		Order.mapInput(Order.Boolean, isSessionCheck),
	)
	return Arr.flatMap(evaluators, (evaluator) => [
		...(evaluator.filterableFailCount > 0
			? [
					{
						name: evaluationOptionKey({ name: evaluator.name, verdict: "fail" }),
						count: evaluator.filterableFailCount,
					},
				]
			: []),
		...(evaluator.filterablePassCount > 0
			? [
					{
						name: evaluationOptionKey({ name: evaluator.name, verdict: "pass" }),
						count: evaluator.filterablePassCount,
					},
				]
			: []),
	])
}

/** An option's label: the evaluator's name and the verdict, e.g. "Context window: fail". */
const evaluationOptionLabel = (key: string): string => {
	const option = parseEvaluationOptionKey(key)
	return option === undefined ? key : `${option.name}: ${option.verdict}`
}

/** The evaluation score section, for `llmEvals` orgs with scores in the window or a filter set. */
const evaluationSection = (h: H, model: Model): Html | null => {
	if (!model.hasEvals) return null
	const current = evaluationOf(model.search)
	const options = evaluationOptions(model)
	if (options.length === 0 && current === undefined) return null
	return filterSection(h, {
		title: "Evaluation score",
		options,
		selected: current === undefined ? [] : [evaluationOptionKey(current)],
		isSearchable: options.length > 8,
		description:
			"Sessions whose latest score from this evaluator has this verdict, on any of their traces or on the session itself. Counts are scores, not sessions.",
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onToggle: (key) => Message.ToggledEvaluation({ key }),
		getOptionLabel: evaluationOptionLabel,
	})
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
			singleCheckbox(
				h,
				"Hide single-trace sessions",
				"A framework that reports no session ID gets one session per trace. This hides those; a session with its own ID stays, however many traces it spans.",
				search.grouped === true,
				Message.ToggledGrouped(),
			),
			facetSection(
				h,
				model,
				{ title: "Environment", facet: "environments", isSearchable: false },
				facets.environments,
			),
			facetSection(
				h,
				model,
				{ title: "Service", facet: "services", isSearchable: true },
				facets.services,
				{ colorOf: getServiceColor },
			),
			facetSection(
				h,
				model,
				{
					title: "Agent",
					facet: "agents",
					isSearchable: true,
					description: "Sessions where any agent span carries this agent name.",
				},
				facets.agents,
			),
			facetSection(
				h,
				model,
				{
					title: "Tool",
					facet: "tools",
					isSearchable: true,
					description: "Sessions that called this tool at least once.",
				},
				facets.tools,
			),
			evaluationSection(h, model),
			facetSection(
				h,
				model,
				{
					title: "Framework",
					facet: "vendors",
					isSearchable: false,
					description:
						"The agent framework that ran the session, recognised at ingest from the attributes its instrumentation writes. Unidentified is AI telemetry no known framework matched.",
				},
				facets.vendors,
				{ getOptionLabel: vendorLabel, getOptionIcon: vendorIcon, getOptionIconColor: vendorColor },
			),
			facetSection(
				h,
				model,
				{
					title: "Model",
					facet: "models",
					isSearchable: true,
					description: "Sessions where any agent span ran on this model.",
				},
				facets.models,
				{
					getOptionLabel: (name) => detect(name).displayName,
					getOptionIcon: (name) => modelVendorIcon(detect(name)),
					getOptionIconColor: (name) => modelVendorColor(detect(name)),
				},
			),
			filterSidebarDivider(h),
			...Arr.map(RANGES, (spec) => rangeSection(h, model, distributions, spec)),
		]),
	])
}

/** The filter rail; its Mount starts the rail's model detection. */
export const filtersRail = (h: H, model: Model): Html =>
	h.div(
		[h.Class("contents"), h.OnMount(MountFilterRail())],
		[
			AsyncData.matchData(model.facets.data, {
				onEmpty: () => filterSidebarLoading(h, 4),
				onFailure: (failure) =>
					filterSidebarError(
						h,
						failure,
						undefined,
						Option.getOrUndefined(AsyncData.getError(model.firstPage.data)),
					),
				onData: (facets) => loadedRail(h, model, facets),
			}),
		],
	)
