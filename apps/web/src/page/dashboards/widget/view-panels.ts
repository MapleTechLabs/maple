import { FUNNEL_MAX_STEPS, PATHS_MAX_BRANCHES, PATHS_MAX_DEPTH } from "@maple/query-model"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AsyncData } from "foldkit"
import { Option, Array as Arr, Record as Rec } from "effect"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { input } from "@maple/views/ui/input"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import type { EditorState } from "./editor-state"
import { validationErrorOf } from "./lowering"
import type { Message } from "./message"
import type { Model } from "./model"
import { ProductEdit } from "./product-edit"
import type { Suggestion, SuggestionLookup } from "./suggestions"
import {
	addOnBar,
	breakdownRow,
	FUNNEL_SOURCES,
	keyByRow,
	panelShell,
	populationFilter,
	product,
	rowLabel,
	runRow,
	windowRow,
} from "./view-product"
import { stepBuilder } from "./view-steps"
import { lookupField } from "../../kit/autocomplete-lookups"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"

// `FunnelQueryPanel` and `PathsQueryPanel`, each
// with the Run preview row the editor page puts under it.

type H = HtmlBuilder<Message>

/** A lookup's rows; the event names fall back to the provider's when it asked first (no counts). */
const suggestionsOf = (model: Model, lookup: SuggestionLookup): ReadonlyArray<Suggestion> => {
	const own = Option.getOrUndefined(AsyncData.getData(model.suggestions[lookup]?.data ?? AsyncData.Idle()))
	if (own !== undefined) return own
	if (lookup !== "eventNames") return []
	const names = lookupField(
		Option.getOrUndefined(
			AsyncData.getData(model.autocomplete.productEventNames?.data ?? AsyncData.Idle()),
		),
		"keys",
	)
	return Arr.map(names, (name) => ({ name, count: null, field: null }))
}

const FUNNEL_ADD_ONS = [
	{ key: "keyBy", label: "Count by" },
	{ key: "window", label: "Window" },
	{ key: "breakdown", label: "Breakdown" },
] as const

export const funnelPanel = (h: H, model: Model, state: EditorState): ReadonlyArray<Html> => {
	const funnel = state.funnel
	const hasAddOn = Arr.some(Rec.values(funnel.addOns), Boolean)
	return [
		panelShell(h, model, "funnel-source", FUNNEL_SOURCES, [
			h.div(
				[h.Class("space-y-1.5")],
				[
					hstack(h, { gap: "2", align: "baseline" }, [
						eyebrow(h, {}, ["Steps"]),
						typography(h, { size: "3xs", tone: "muted", mono: true }, [
							"in order · session step only first · up to 10",
						]),
					]),
					stepBuilder(h, model, {
						scope: "funnel",
						steps: funnel.steps,
						eventNames: suggestionsOf(model, "eventNames"),
						pagePaths: suggestionsOf(model, "pagePaths"),
						eventStepFilter: true,
						maxSteps: FUNNEL_MAX_STEPS,
					}),
				],
			),
			populationFilter(h, model, "funnel", funnel.filterClause, "Funnel population filter"),
			addOnBar(h, FUNNEL_ADD_ONS, funnel.addOns, (key) =>
				product(ProductEdit.ToggledFunnelAddOn({ key })),
			),
			...(hasAddOn
				? [
						h.div(
							[h.Class("space-y-2 pt-1")],
							[
								...(funnel.addOns.keyBy ? [keyByRow(h, model, "funnel", funnel.keyBy)] : []),
								...(funnel.addOns.window
									? [
											windowRow(h, model, "funnel", funnel.windowSeconds, {
												label: "Window",
												ariaLabel: "Conversion window",
												className: "h-8 w-40 text-xs",
												hint: "the whole chain must complete within this long of step 1",
											}),
										]
									: []),
								...(funnel.addOns.breakdown
									? [breakdownRow(h, model, funnel.breakdownBy)]
									: []),
							],
						),
					]
				: []),
		]),
		runRow(h, validationErrorOf(state)),
	]
}

const PATHS_ADD_ONS = [
	{ key: "keyBy", label: "Count by" },
	{ key: "window", label: "Within" },
	{ key: "include", label: "Include" },
	{ key: "exclude", label: "Exclude" },
] as const

const DEPTH_OPTIONS = Array.from({ length: PATHS_MAX_DEPTH }, (_, index) => ({
	value: String(index + 1),
	label: String(index + 1),
}))
const BRANCH_OPTIONS = Arr.map([3, 4, 6, PATHS_MAX_BRANCHES], (value) => ({
	value: String(value),
	label: String(value),
}))

const segments = <T extends string>(
	h: H,
	ariaLabel: string,
	value: T,
	options: ReadonlyArray<{ value: T; label: string }>,
	onChange: (value: T) => Message,
): Html => segmentedSelect(h, { options, value, onChange, size: "sm", ariaLabel, className: "*:text-xs" })

const pathsAddOns = (h: H, model: Model, paths: EditorState["paths"]): ReadonlyArray<Html> => [
	...(paths.addOns.keyBy ? [keyByRow(h, model, "paths", paths.keyBy)] : []),
	...(paths.addOns.window
		? [
				windowRow(h, model, "paths", paths.windowSeconds, {
					label: "Within",
					ariaLabel: "Window",
					size: "sm",
					className: "w-40",
					hint: "of the anchor",
				}),
			]
		: []),
	...(paths.addOns.include
		? [
				hstack(h, { gap: "2" }, [
					rowLabel(h, "Include"),
					segments(
						h,
						"Include",
						paths.include,
						[
							{ value: "all", label: "Events + pages" },
							{ value: "events", label: "Events" },
							{ value: "pages", label: "Pages" },
						],
						(include) => product(ProductEdit.SetPathsInclude({ include })),
					),
				]),
			]
		: []),
	...(paths.addOns.exclude
		? [
				hstack(h, { gap: "2" }, [
					rowLabel(h, "Exclude"),
					input(h, {
						id: "widget-paths-exclude",
						size: "sm",
						className: "w-[320px] font-mono text-xs",
						attributes: [
							h.Value(paths.excludeText),
							h.Placeholder("heartbeat, /, /health"),
							h.AriaLabel("Excluded names"),
							h.OnInput((value) => product(ProductEdit.ChangedPathsExclude({ value }))),
						],
					}),
					typography(h, { size: "2xs", tone: "muted" }, [
						"event names or page paths, comma-separated, dropped before sequencing",
					]),
				]),
			]
		: []),
]

export const pathsPanel = (h: H, model: Model, state: EditorState): ReadonlyArray<Html> => {
	const paths = state.paths
	const hasAddOn = Arr.some(Rec.values(paths.addOns), Boolean)
	return [
		panelShell(
			h,
			model,
			"paths-source",
			["product_events"],
			[
				h.div(
					[h.Class("space-y-1.5")],
					[
						hstack(h, { gap: "2" }, [
							eyebrow(h, {}, ["Paths"]),
							segments(
								h,
								"Direction",
								paths.direction,
								[
									{ value: "after", label: "After" },
									{ value: "before", label: "Before" },
								],
								(direction) => product(ProductEdit.SetPathsDirection({ direction })),
							),
							typography(h, { size: "3xs", tone: "muted", mono: true }, [
								paths.direction === "after"
									? "what people did next, from the first time they hit the anchor"
									: "how people got there, back from the last time they hit the anchor",
							]),
						]),
						stepBuilder(h, model, {
							scope: "paths",
							steps: [paths.anchor],
							eventNames: suggestionsOf(model, "eventNames"),
							pagePaths: suggestionsOf(model, "pagePaths"),
							eventStepFilter: false,
							maxSteps: 1,
						}),
					],
				),
				hstack(h, { wrap: true, className: "gap-x-4 gap-y-2" }, [
					hstack(h, { gap: "2" }, [
						rowLabel(h, "Steps"),
						segments(h, "Steps", String(paths.depth), DEPTH_OPTIONS, (depth) =>
							product(ProductEdit.SetPathsDepth({ depth: Number(depth) })),
						),
					]),
					hstack(h, { gap: "2" }, [
						rowLabel(
							h,
							"Branches",
							typographyClass({ size: "2xs", tone: "muted", className: "shrink-0" }),
						),
						segments(h, "Branches per step", String(paths.branches), BRANCH_OPTIONS, (branches) =>
							product(ProductEdit.SetPathsBranches({ branches: Number(branches) })),
						),
						typography(h, { size: "2xs", tone: "muted" }, [
							"named per step, the rest fold into Other",
						]),
					]),
				]),
				populationFilter(h, model, "paths", paths.filterClause, "Paths population filter"),
				addOnBar(h, PATHS_ADD_ONS, paths.addOns, (key) =>
					product(ProductEdit.ToggledPathsAddOn({ key })),
				),
				...(hasAddOn ? [h.div([h.Class("space-y-2 pt-1")], pathsAddOns(h, model, paths))] : []),
			],
		),
		runRow(h, validationErrorOf(state)),
	]
}
