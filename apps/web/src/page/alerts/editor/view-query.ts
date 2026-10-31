import type { AlertSignalType } from "@maple/domain/http"
import { GROUP_BY_OPTIONS } from "@maple/query-engine/query-builder"
import { signalTypeToKind } from "@maple/web-data/alerts/rule-modes"
import { cn } from "@maple/ui/lib/utils"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { card } from "../../../ui/card"
import * as Combobox from "../../../ui/combobox"
import { chipsView } from "../../../ui/combobox-view"
import { icon, type IconName } from "../../../ui/icon"
import * as RadioGroup from "../../../ui/radio-group"
import { segmentedSelect } from "../../../ui/segmented-select"
import { stableSlice } from "../../kit/stable-slice"
import { queryPanelView } from "../../kit/query-builder/view"
import { spanAttributeKeysOf, traceFacetsOf } from "./derive-rows"
import { baseValuesOf } from "./where-inputs"
import type { RuleForm } from "./form"
import type { AlertQueryTiming } from "@maple/domain/http"
import { draftTimingOf } from "./derive-rows"
import { Message, type SignalKind } from "./message"
import type { Model } from "./model"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "../../../ui/input-group"
import { rawQueryEditor, REDUCER_SELECT_ID, type SqlView } from "./view-sql"

// `RuleQuerySection`: Built-in, the query builder's
// `QueryPanel`, or SQL, over the same draft.

type H = HtmlBuilder<Message>

/** What the section reads off the Model. */
type QueryView = SqlView &
	Pick<Model, "kindNotice" | "queryPanels" | "combos" | "traceFacets" | "autocomplete">

const KIND_OPTIONS: ReadonlyArray<{ value: SignalKind; label: string }> = [
	{ value: "builtin", label: "Built-in" },
	{ value: "builder_query", label: "Query builder" },
	{ value: "raw_query", label: "SQL" },
]

const KIND_HINT = new Map<SignalKind, string>([
	["builtin", "Five common signals on root spans. Switching modes carries the filters over."],
	["builder_query", "Same builder as dashboards. Switching to Built-in keeps what it can express."],
	["raw_query", "ClickHouse SQL, replayed per evaluation window."],
])

const BUILTIN_SIGNALS: ReadonlyArray<{
	value: AlertSignalType
	label: string
	hint: string
	icon: IconName
}> = [
	{ value: "error_rate", label: "Error rate", hint: "failed / all", icon: "CircleXmarkIcon" },
	{ value: "p95_latency", label: "P95", hint: "latency", icon: "ClockIcon" },
	{ value: "p99_latency", label: "P99", hint: "tail latency", icon: "ArrowTrendUpIcon" },
	{ value: "apdex", label: "Apdex", hint: "satisfaction", icon: "CircleCheckIcon" },
	{ value: "throughput", label: "Throughput", hint: "requests / window", icon: "PulseIcon" },
]

const SIGNAL_CLASS = cn(
	"group flex cursor-pointer flex-col items-start gap-0.5 border-b-2 border-transparent px-3 py-2.5 text-left",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
	"data-[checked]:border-primary data-[checked]:bg-surface-sunken",
	"[&:not([data-checked])]:hover:bg-surface-faint [&:not([data-checked])]:active:bg-surface-faint",
)

const signalRadios = (h: H, form: RuleForm): Html => {
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: RadioGroup.init(form.signalType),
		toParentMessage: (message) => Message.GotRadioMessage({ group: "signal", message }),
		items: BUILTIN_SIGNALS.map((signal) => ({
			value: signal.value,
			id: `rule-signal-${signal.value}`,
			inputId: `rule-signal-${signal.value}-input`,
		})),
	}
	return h.div(
		[
			h.AriaLabel("Built-in signal"),
			h.Class("grid grid-cols-2 border-b sm:grid-cols-5"),
			h.Role("radiogroup"),
		],
		BUILTIN_SIGNALS.flatMap((signal) =>
			RadioGroup.radio(h, config, signal.value, SIGNAL_CLASS, {
				children: [
					h.span(
						[h.Class("flex items-center gap-1.5 text-sm font-medium")],
						[
							icon(h, signal.icon, {
								size: 14,
								className: "shrink-0 text-muted-foreground group-data-[checked]:text-primary",
							}),
							signal.label,
						],
					),
					h.span([h.Class("pl-5 text-2xs text-muted-foreground")], [signal.hint]),
				],
			}),
		),
	)
}

/** A `MultiSelectCombobox` in chips mode, kept by id; its selection is the form's. */
const chipsPicker = (
	h: H,
	model: QueryView,
	id: string,
	selected: ReadonlyArray<string>,
	options: Readonly<{
		items: ReadonlyArray<string>
		placeholder: string
		emptyText: string
		className?: string
		wrapperClassName?: string
		isDisabled?: boolean
	}>,
): Html => {
	const current = model.combos[id] ?? Combobox.init(id, "multiple")
	return h.submodel({
		slotId: `alert-rule-combo-${id}`,
		model: { ...current, selected },
		view: chipsView,
		toParentMessage: (message) => Message.GotComboMessage({ id, message }),
		viewInputs: {
			items: options.items,
			placeholder: options.placeholder,
			emptyText: options.emptyText,
			className: options.className,
			isDisabled: options.isDisabled,
			toView: (parts) =>
				h.div(
					options.wrapperClassName === undefined ? [] : [h.Class(options.wrapperClassName)],
					parts,
				),
		},
	})
}

/** `GroupByMultiSelect` over traces: the built-in dimensions and the span attributes as `attr.*`. */
const groupByItems = (model: QueryView): ReadonlyArray<string> => [
	...new Set([
		...GROUP_BY_OPTIONS.traces.filter((option) => option.value !== "none").map((option) => option.value),
		...spanAttributeKeysOf(model).map((key) => `attr.${key}`),
	]),
]

/** `BuiltinRow`: a label column and the control. */
const builtinRow = (h: H, label: string, htmlFor: string, hint: string | undefined, control: Html): Html =>
	h.div(
		[h.Class("grid items-start gap-1 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-3")],
		[
			h.label([h.Class("pt-2 text-sm text-muted-foreground"), h.For(htmlFor)], [label]),
			h.div(
				[h.Class("min-w-0 space-y-1")],
				[
					control,
					...(hint === undefined ? [] : [h.p([h.Class("text-2xs text-muted-foreground")], [hint])]),
				],
			),
		],
	)

const inputOf = Combobox.inputId

/** `BuiltinQueryForm`: the five canned signals and their scope. */
const builtinForm = (h: H, model: QueryView, form: RuleForm): Html => {
	const hasServices = form.serviceNames.length > 0
	const facets = traceFacetsOf(model)
	return card(
		h,
		[
			signalRadios(h, form),
			h.div(
				[h.Class("space-y-2 p-3")],
				[
					builtinRow(
						h,
						"Services",
						inputOf("rule-services"),
						undefined,
						chipsPicker(h, model, "rule-services", form.serviceNames, {
							items: facets.services,
							placeholder: hasServices ? "Add service…" : "All services",
							emptyText: "No services found.",
						}),
					),
					builtinRow(
						h,
						"Environment",
						inputOf("rule-environments"),
						undefined,
						chipsPicker(h, model, "rule-environments", form.environments, {
							items: facets.environments,
							placeholder:
								form.environments.length === 0 ? "All environments" : "Add environment…",
							emptyText: "No environments found.",
						}),
					),
					builtinRow(
						h,
						"Split by",
						inputOf("rule-group-by"),
						hasServices ? "Each selected service is already its own group." : undefined,
						chipsPicker(h, model, "rule-group-by", form.groupBy, {
							items: groupByItems(model),
							placeholder: form.groupBy.length === 0 ? "service.name" : "",
							emptyText: "No fields found.",
							className: "text-xs font-mono",
							wrapperClassName: "w-full",
							isDisabled: hasServices,
						}),
					),
					builtinRow(
						h,
						"Exclude",
						inputOf("rule-exclude"),
						undefined,
						chipsPicker(h, model, "rule-exclude", form.excludeServiceNames, {
							items: facets.services,
							placeholder: hasServices ? "Only applies to all services" : "Skip these services",
							emptyText: "No services found.",
							isDisabled: hasServices,
						}),
					),
					...(form.signalType === "apdex"
						? [
								builtinRow(
									h,
									"Apdex target",
									"apdex-threshold",
									undefined,
									inputGroup(h, { className: "w-40" }, [
										inputGroupInput(h, {
											id: "apdex-threshold",
											type: "number",
											controlClassName: "font-mono tabular-nums",
											attributes: [
												h.InputMode("numeric"),
												h.Value(form.apdexThresholdMs),
												h.OnInput((value) =>
													Message.ChangedField({
														field: "apdexThresholdMs",
														value,
													}),
												),
											],
										}),
										inputGroupAddon(h, { align: "inline-end" }, [
											inputGroupText(h, {}, ["ms"]),
										]),
									]),
								),
							]
						: []),
				],
			),
			h.div(
				[
					h.Class(
						"flex flex-wrap items-center justify-between gap-2 border-t border-dashed px-3 py-2 text-xs text-muted-foreground",
					),
				],
				[
					h.span(
						[],
						[
							"Measured on root spans. A service that records failures on child spans and returns success from its entry point stays healthy here.",
						],
					),
					button(
						h,
						{
							variant: "link",
							size: "xs",
							attributes: [h.OnClick(Message.ClickedOpenInBuilder())],
						},
						["Open in query builder"],
					),
				],
			),
		],
		"gap-0 overflow-hidden p-0",
	)
}

/** `AlertQueryPanel`: the dashboard `QueryPanel` without Clone, Remove or the visibility box. */
const builderPanel = (h: H, model: QueryView, form: RuleForm): Html =>
	h.div(
		[h.Class("space-y-1.5")],
		[
			h.submodel({
				slotId: "alert-rule-query",
				model: model.queryPanels,
				view: queryPanelView,
				viewInputs: {
					query: form.queryBuilderDraft,
					index: 0,
					canRemove: false,
					intervalPlaceholder: "Auto",
					hasHeaderActions: false,
					hasVisibilityToggle: false,
					autocompleteValues: baseValuesOf(model, form.queryBuilderDraft),
				},
				toParentMessage: (message) => Message.GotQueryPanelMessage({ message }),
			}),
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				["Each group is checked on its own and gets its own incident."],
			),
		],
	)

const query = (h: H, model: QueryView, form: RuleForm, timing: AlertQueryTiming | null): Html => {
	const kind = signalTypeToKind(form.signalType)
	return h.div(
		[h.Class("space-y-2")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-3")],
				[
					segmentedSelect(h, {
						options: KIND_OPTIONS,
						value: kind,
						onChange: (next) => Message.ClickedSignalKind({ kind: next }),
						ariaLabel: "Query mode",
						size: "sm",
					}),
					h.p(
						[h.Class("min-w-0 flex-1 text-xs text-muted-foreground")],
						[model.kindNotice ?? KIND_HINT.get(kind) ?? ""],
					),
				],
			),
			kind === "builtin"
				? builtinForm(h, model, form)
				: kind === "builder_query"
					? builderPanel(h, model, form)
					: rawQueryEditor(h, model, form, timing),
		],
	)
}

const slot = createLazy()
const viewOf = stableSlice((model: Model): QueryView => ({
	kindNotice: model.kindNotice,
	queryPanels: model.queryPanels,
	combos: model.combos,
	traceFacets: model.traceFacets,
	autocomplete: model.autocomplete,
	isSqlCollapsed: model.isSqlCollapsed,
	reducerSelect: model.selects[REDUCER_SELECT_ID],
}))

/** Step 1, "What to watch"; `form` is the evaluated draft (`evaluatedFormOf`). */
export const querySection = (h: H, model: Model, form: RuleForm): Html =>
	slot(query, [h, viewOf(model), form, draftTimingOf(model, form)])
