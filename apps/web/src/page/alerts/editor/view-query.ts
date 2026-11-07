import type { AlertSignalType, AnomalySignalType } from "@maple/domain/http"
import { ANOMALY_SIGNAL_LABELS, ANOMALY_SIGNALS } from "@maple/web-data/alerts/anomaly-rule"
import { GROUP_BY_OPTIONS } from "@maple/query-engine/query-builder"
import { signalTypeToKind } from "@maple/web-data/alerts/rule-modes"
import { cn } from "@maple/ui/lib/utils"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { card } from "@maple/views/ui/card"
import * as Combobox from "@maple/views/ui/combobox"
import { chipsView } from "@maple/views/ui/combobox-view"
import { icon, type IconName } from "@maple/views/ui/icon"
import { label } from "@maple/views/ui/label"
import * as RadioGroup from "@maple/views/ui/radio-group"
import { multiSegmentedSelect, segmentedSelect } from "@maple/views/ui/segmented-select"
import { stableSlice } from "../../kit/stable-slice"
import { queryPanelView } from "../../kit/query-builder/view"
import { isProtectedDefault } from "./derive"
import { spanAttributeKeysOf, traceFacetsOf } from "./derive-rows"
import { baseValuesOf } from "./where-inputs"
import type { RuleForm } from "./form"
import type { AlertQueryTiming } from "@maple/domain/http"
import { draftTimingOf } from "./derive-rows"
import { Message, type SignalKind } from "./message"
import type { Model } from "./model"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "@maple/views/ui/input-group"
import { rawQueryEditor, REDUCER_SELECT_ID, type SqlView } from "./view-sql"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// `RuleQuerySection`: Built-in, the query builder's
// `QueryPanel`, or SQL, over the same draft.

type H = HtmlBuilder<Message>

/** What the section reads off the Model. */
type QueryView = SqlView &
	Pick<Model, "kindNotice" | "queryPanels" | "combos" | "traceFacets" | "autocomplete"> & {
		/** Editing the org's default anomaly rule: its kind and scope are fixed. */
		readonly isDefaultAnomaly: boolean
	}

const KIND_OPTIONS: ReadonlyArray<{ value: SignalKind; label: string }> = [
	{ value: "builtin", label: "Built-in" },
	{ value: "builder_query", label: "Query builder" },
	{ value: "raw_query", label: "SQL" },
	{ value: "anomaly", label: "Anomaly" },
]

const KIND_HINT = new Map<SignalKind, string>([
	["builtin", "Five common signals on root spans. Switching modes carries the filters over."],
	["builder_query", "Same builder as dashboards. Switching to Built-in keeps what it can express."],
	["raw_query", "ClickHouse SQL, replayed per evaluation window."],
	["anomaly", "No query to write: Maple's anomaly detector decides what is unusual."],
])

const ANOMALY_DESCRIPTION =
	"Pages when Maple detects unusual error rate, latency, throughput, error spikes or log volume. The most specific anomaly rule handles each anomaly."

const SCOPE_NEEDED_NOTE =
	"Pick at least one service, environment or signal. Maple's default anomaly rule already covers everything."

const DEFAULT_ANOMALY_NOTE =
	"This is the default anomaly rule. It handles every anomaly no narrower rule covers, so its scope stays empty and it stays on."

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
		items: Arr.map(BUILTIN_SIGNALS, (signal) => ({
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
		Arr.flatMap(BUILTIN_SIGNALS, (signal) =>
			RadioGroup.radio(h, config, signal.value, SIGNAL_CLASS, {
				children: [
					hstack(h, { gap: "1.5", align: "center", as: "span", className: "text-sm font-medium" }, [
						icon(h, signal.icon, {
							size: 14,
							className: "shrink-0 text-muted-foreground group-data-[checked]:text-primary",
						}),
						signal.label,
					]),
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
		...Arr.map(
			Arr.filter(GROUP_BY_OPTIONS.traces, (option) => option.value !== "none"),
			(option) => option.value,
		),
		...Arr.map(spanAttributeKeysOf(model), (key) => `attr.${key}`),
	]),
]

/** `BuiltinRow`: a label column and the control. */
const builtinRow = (h: H, text: string, htmlFor: string, hint: string | undefined, control: Html): Html =>
	h.div(
		[h.Class("grid items-start gap-1 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-3")],
		[
			label(
				h,
				{
					className: "pt-2 font-normal text-sm text-muted-foreground sm:text-sm",
					attributes: [h.For(htmlFor)],
				},
				[text],
			),
			h.div(
				[h.Class("min-w-0 space-y-1")],
				[
					control,
					...(hint === undefined
						? []
						: [typography(h, { size: "2xs", tone: "muted", as: "p" }, [hint])]),
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
							emptyText: "No services found",
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
							emptyText: "No environments found",
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
							emptyText: "No fields found",
							className: typographyClass({ size: "xs", mono: true }),
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
							emptyText: "No services found",
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
											controlClassName: typographyClass({ mono: true, numeric: true }),
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
			hstack(
				h,
				{
					gap: "2",
					align: "center",
					justify: "between",
					wrap: true,
					className: "border-t border-dashed px-3 py-2 text-xs text-muted-foreground",
				},
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

/** An anomaly rule's scope: services, environments and detector signals, each empty for all. */
const anomalyForm = (h: H, model: QueryView, form: RuleForm): Html => {
	const facets = traceFacetsOf(model)
	const isLocked = model.isDefaultAnomaly
	const isUnscoped =
		form.serviceNames.length === 0 && form.environments.length === 0 && form.anomalySignals.length === 0
	return card(
		h,
		[
			h.div(
				[h.Class("space-y-1 border-b px-3 py-2.5")],
				[
					typography(h, { size: "sm", tone: "foreground", as: "p" }, [ANOMALY_DESCRIPTION]),
					...(isLocked
						? [
								hstack(
									h,
									{
										gap: "1.5",
										align: "start",
										className: typographyClass({ size: "xs", tone: "muted" }),
									},
									[
										icon(h, "LockIcon", { size: 12, className: "mt-0.5 shrink-0" }),
										h.span([], [DEFAULT_ANOMALY_NOTE]),
									],
								),
							]
						: isUnscoped
							? [typography(h, { size: "xs", tone: "warning", as: "p" }, [SCOPE_NEEDED_NOTE])]
							: []),
				],
			),
			h.div(
				[h.Class("space-y-2 p-3")],
				[
					builtinRow(
						h,
						"Services",
						inputOf("rule-services"),
						"Empty covers every service.",
						chipsPicker(h, model, "rule-services", form.serviceNames, {
							items: facets.services,
							placeholder: form.serviceNames.length > 0 ? "Add service…" : "All services",
							emptyText: "No services found",
							isDisabled: isLocked,
						}),
					),
					builtinRow(
						h,
						"Environment",
						inputOf("rule-environments"),
						"Empty covers every environment.",
						chipsPicker(h, model, "rule-environments", form.environments, {
							items: facets.environments,
							placeholder:
								form.environments.length === 0 ? "All environments" : "Add environment…",
							emptyText: "No environments found",
							isDisabled: isLocked,
						}),
					),
					builtinRow(
						h,
						"Signals",
						ANOMALY_SIGNALS_ID,
						form.anomalySignals.length === 0
							? "None picked: every signal pages."
							: "Only the picked signals page.",
						h.div(
							[h.Id(ANOMALY_SIGNALS_ID)],
							[
								multiSegmentedSelect<AnomalySignalType, Message>(h, {
									options: Arr.map(ANOMALY_SIGNALS, (signal) => ({
										value: signal,
										label: ANOMALY_SIGNAL_LABELS[signal],
										ariaLabel: ANOMALY_SIGNAL_LABELS[signal],
									})),
									value: form.anomalySignals,
									onToggle: (signal) => Message.ToggledAnomalySignal({ signal }),
									size: "sm",
									ariaLabel: "Anomaly signals",
									isDisabled: isLocked,
									className: "flex-wrap",
								}),
							],
						),
					),
				],
			),
		],
		"gap-0 overflow-hidden p-0",
	)
}

const ANOMALY_SIGNALS_ID = "rule-anomaly-signals"

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
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				"Each group is checked on its own and gets its own incident.",
			]),
		],
	)

const query = (h: H, model: QueryView, form: RuleForm, timing: AlertQueryTiming | null): Html => {
	const kind = signalTypeToKind(form.signalType)
	return h.div(
		[h.Class("space-y-2")],
		[
			hstack(h, { gap: "3", wrap: true }, [
				segmentedSelect(h, {
					options: model.isDefaultAnomaly
						? Arr.map(KIND_OPTIONS, (option) => ({
								...option,
								isDisabled: option.value !== "anomaly",
							}))
						: KIND_OPTIONS,
					value: kind,
					onChange: (next) => Message.ClickedSignalKind({ kind: next }),
					ariaLabel: "Query mode",
					size: "sm",
					// Four modes outgrow a phone's width: the track wraps instead of clipping the last one.
					className: "max-w-full flex-wrap",
				}),
				typography(h, { size: "xs", tone: "muted", as: "p", className: "min-w-0 flex-1" }, [
					model.kindNotice ?? KIND_HINT.get(kind) ?? "",
				]),
			]),
			kind === "anomaly"
				? anomalyForm(h, model, form)
				: kind === "builtin"
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
	isDefaultAnomaly: isProtectedDefault(model),
}))

/** Step 1, "What to watch"; `form` is the evaluated draft (`evaluatedFormOf`). */
export const querySection = (h: H, model: Model, form: RuleForm): Html =>
	slot(query, [h, viewOf(model), form, draftTimingOf(model, form)])
