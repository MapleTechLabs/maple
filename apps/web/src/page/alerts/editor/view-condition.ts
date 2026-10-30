import type { AlertQueryTiming, AlertSeverity } from "@maple/domain/http"
import { alertIntervalsFitting } from "@maple/query-engine/datetime"
import {
	comparatorSupportsTiers,
	isRangeComparator,
	thresholdUnitLabel,
} from "@maple/web-data/alerts/form-utils"
import { cn } from "@maple/ui/lib/utils"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { card } from "../../../ui/card"
import { eyebrow } from "../../../ui/eyebrow"
import { field, fieldLabel } from "../../../ui/field"
import { icon } from "../../../ui/icon"
import * as RadioGroup from "../../../ui/radio-group"
import { statusDot } from "../../../ui/status-dot"
import type * as Select from "../../../ui/select"
import { stableSlice } from "../../kit/stable-slice"
import { COMPARATOR_WORDS, comparatorWords, recoveryLabel } from "./derive"
import { draftTimingOf } from "./derive-rows"
import type { RuleForm } from "./form"
import {
	AUTO_INTERVAL,
	autoIntervalMinutes,
	formIntervalMinutes,
	intervalOptions,
	intervalRadioValue,
} from "./interval"
import { Message, type TextField } from "./message"
import type { Model } from "./model"
import { fieldStateOf, idsOf, numberField, wasNote } from "./view-fields"
import { formSelect } from "./view-select"

// `RuleConditionFields`: the rule's condition row.

type H = HtmlBuilder<Message>

const COMPARATOR_SELECT_ID = "rule-comparator"

/** What the card reads off the Model: the dirty and saved values, and the comparator select's state. */
type ConditionView = Pick<Model, "mountedForm" | "savedForm"> &
	Readonly<{
		comparatorSelect: Select.Model | undefined
		/** The edited rule's slowdown after query timeouts, which saving clears. */
		slowedMinutes: number | null
	}>

/** `COMPARATOR_ITEMS`, in `comparatorLabels` order. */
const COMPARATOR_ITEMS = [...COMPARATOR_WORDS].map(([value, label]) => ({ value, label }))

const SEVERITY_OPTIONS: ReadonlyArray<{
	value: AlertSeverity
	label: string
	selected: string
	dot: string
}> = [
	{
		value: "warning",
		label: "Warning",
		selected: "border-severity-warn/60 bg-severity-warn/10 text-severity-warn",
		dot: "bg-severity-warn",
	},
	{
		value: "critical",
		label: "Critical",
		selected: "border-severity-error/60 bg-severity-error/10 text-severity-error",
		dot: "bg-severity-error",
	},
]

const filledState = fieldStateOf("x", undefined)

/** `SeverityPicker`: the one tier's severity, as two pills. */
const severityPicker = (h: H, value: AlertSeverity): Html => {
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: RadioGroup.init(value),
		toParentMessage: (message) => Message.GotRadioMessage({ group: "severity", message }),
		items: SEVERITY_OPTIONS.map((option) => ({
			value: option.value,
			id: `rule-severity-${option.value}`,
			inputId: `rule-severity-${option.value}-input`,
		})),
	}
	const ids = { control: "rule-severity-input", label: "rule-severity-label", error: "rule-severity-error" }
	return field(h, { className: "items-stretch gap-1.5", state: filledState }, [
		fieldLabel(h, { ids, state: filledState }, "Severity"),
		h.div(
			[
				h.AriaLabelledBy("rule-severity-label"),
				h.Class("grid grid-cols-2 gap-1 rounded-md bg-surface-sunken p-0.5"),
				h.DataAttribute("filled", ""),
				h.Role("radiogroup"),
			],
			SEVERITY_OPTIONS.flatMap((option) => {
				const isSelected = value === option.value
				return RadioGroup.radio(
					h,
					config,
					option.value,
					cn(
						"inline-flex h-8 cursor-pointer select-none items-center justify-center gap-1.5 rounded-sm border border-transparent px-2.5 text-xs font-medium",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						isSelected
							? option.selected
							: "text-muted-foreground hover:bg-surface-sunken hover:text-foreground",
					),
					{
						children: [
							statusDot(h, {
								tone: "custom",
								className: isSelected ? option.dot : "bg-muted-foreground/40",
							}),
							option.label,
						],
					},
				)
			}),
		),
	])
}

/** `TierLabel`: the fixed severity of a row once a rule has two tiers. */
const tierLabel = (h: H, severity: AlertSeverity): Html => {
	const option = SEVERITY_OPTIONS.find((candidate) => candidate.value === severity) ?? SEVERITY_OPTIONS[0]
	const ids = idsOf(`rule-tier-${severity}`, false)
	return field(h, { className: "items-stretch gap-1.5", state: fieldStateOf("", undefined) }, [
		fieldLabel(h, { ids, state: fieldStateOf("", undefined) }, "Severity"),
		h.span(
			[
				h.Class(
					cn(
						"inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium",
						option?.selected,
					),
				),
			],
			[statusDot(h, { tone: "custom", className: option?.dot ?? "" }), option?.label ?? ""],
		),
	])
}

/** The saved value of a field when the draft changed it (`was`). */
const wasOf = (saved: RuleForm | null, form: RuleForm, pick: (form: RuleForm) => string): string | null =>
	saved !== null && pick(saved).trim() !== pick(form).trim() ? pick(saved) : null

const comparatorRow = (h: H, model: ConditionView, form: RuleForm, saved: RuleForm | null): Html => {
	const comparatorWas = wasOf(saved, form, (f) => f.comparator)
	const ids = idsOf("rule-comparator", false)
	const state = fieldStateOf(form.comparator, undefined)
	return h.div(
		[h.Class("grid items-start gap-4 p-4 md:grid-cols-3")],
		[
			formSelect(h, model.comparatorSelect, COMPARATOR_SELECT_ID, form.comparator, COMPARATOR_ITEMS, {
				className: cn("h-9 w-full", comparatorWas !== null && "border-severity-warn/60"),
				ariaLabel: "Condition",
				labelledBy: ids.label,
				toView: (parts) =>
					field(h, { className: "items-stretch gap-1.5", state }, [
						fieldLabel(h, { ids, state }, "Alert when the value"),
						...parts,
						...(comparatorWas === null
							? []
							: [wasNote(h, [comparatorWords(saved?.comparator ?? form.comparator)])]),
					]),
			}),
			...(!comparatorSupportsTiers(form.comparator) && form.escalation !== null
				? [
						h.p(
							[h.Class("text-xs text-muted-foreground md:col-span-2 md:pt-7")],
							["This condition has one tier, so the critical tier is dropped on save."],
						),
					]
				: []),
		],
	)
}

/** A field's value, its mounted value (dirty) and its saved value while editing (was). */
type FieldValues = Readonly<{ value: string; mounted: string | undefined; previous: string | null }>

const valuesOf =
	(model: ConditionView, form: RuleForm, saved: RuleForm | null) =>
	(pick: (form: RuleForm) => string): FieldValues => ({
		value: pick(form),
		mounted: model.mountedForm === null ? undefined : pick(model.mountedForm),
		previous: wasOf(saved, form, pick),
	})

const changed = (field: TextField) => (value: string) => Message.ChangedField({ field, value })

const criticalRow = (
	h: H,
	unit: string | null,
	recovery: string,
	escalationOf: (pick: (tier: NonNullable<RuleForm["escalation"]>) => string) => FieldValues,
): Html =>
	h.div(
		[h.Class("grid items-start gap-4 border-t pt-3 md:grid-cols-3")],
		[
			h.div(
				[h.Class("flex items-center justify-between gap-2")],
				[
					tierLabel(h, "critical"),
					button(
						h,
						{
							variant: "ghost",
							size: "sm",
							className: "mt-6 px-2 text-xs text-muted-foreground",
							attributes: [h.OnClick(Message.ClickedRemoveCriticalTier())],
						},
						["Remove"],
					),
				],
			),
			numberField(h, {
				id: "rule-critical-threshold",
				label: "Threshold",
				ariaLabel: "Critical threshold",
				unit,
				onInput: (value) => Message.ChangedEscalationField({ field: "threshold", value }),
				...escalationOf((tier) => tier.threshold),
			}),
			numberField(h, {
				id: "rule-critical-recovery",
				label: recovery,
				ariaLabel: `Critical ${recovery.toLowerCase()}`,
				placeholder: "Threshold",
				description: "A critical that recovers drops back to warning.",
				unit,
				onInput: (value) => Message.ChangedEscalationField({ field: "recoveryValue", value }),
				...escalationOf((tier) => tier.recoveryValue),
			}),
		],
	)

/** `windowDescription`: what a check reads and how often the scheduler runs one. */
const windowDescription = (form: RuleForm): string => {
	const minutes = Number(form.windowMinutes.trim())
	if (!Number.isFinite(minutes) || minutes <= 0) return "Each check looks at this much data."
	const every = formIntervalMinutes(form)
	return `Each check looks at this much data, checked every ${every === 1 ? "minute" : `${every} min`}.`
}

/** "Check every": the interval, and for raw SQL the query time each one allows. */
const intervalPicker = (
	h: H,
	model: ConditionView,
	form: RuleForm,
	timing: AlertQueryTiming | null,
): Html => {
	const isRaw = form.signalType === "raw_query"
	const options = intervalOptions(form, isRaw ? timing : null)
	const selected = intervalRadioValue(form.evaluationIntervalMinutes)
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: RadioGroup.init(selected),
		toParentMessage: (message) => Message.GotRadioMessage({ group: "interval", message }),
		items: options.map((option) => ({
			value: option.value,
			id: `rule-interval-${option.value}`,
			inputId: `rule-interval-${option.value}-input`,
		})),
	}
	const current = options.find((option) => option.value === selected)
	return field(h, { className: "items-stretch gap-1.5", state: filledState }, [
		h.span([h.Id("rule-interval-label"), h.Class("text-sm font-medium")], ["Check every"]),
		...slowdownNotice(h, model, form),
		h.div(
			[
				h.AriaLabelledBy("rule-interval-label"),
				h.Class(
					"grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1 rounded-md bg-surface-sunken p-0.5",
				),
				h.DataAttribute("filled", ""),
				h.Role("radiogroup"),
			],
			options.flatMap((option) => {
				const isSelected = option.value === selected
				const isBlocked = option.isLongerThanWindow || option.isTooSlow
				return RadioGroup.radio(
					h,
					config,
					option.value,
					cn(
						"flex min-h-8 cursor-pointer select-none flex-col items-center justify-center gap-0.5 rounded-sm border border-transparent px-2 py-1 text-xs font-medium",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						isSelected
							? isBlocked
								? "border-severity-warn/60 bg-severity-warn/10 text-severity-warn"
								: "border-primary/50 bg-primary/10 text-foreground"
							: "text-muted-foreground hover:bg-surface-sunken hover:text-foreground",
						!isSelected && isBlocked && "text-foreground-subtle",
					),
					{
						children: [
							h.span(
								[h.Class(cn("whitespace-nowrap", option.isTooSlow && "line-through"))],
								[option.label],
							),
							...(option.isLongerThanWindow
								? [h.span([h.Class("sr-only")], [", longer than the window"])]
								: option.isTooSlow
									? [h.span([h.Class("sr-only")], [", too slow for this query"])]
									: []),
							...(isRaw
								? [
										h.span(
											[h.Class("text-2xs font-normal tabular-nums opacity-80")],
											[`${option.limitSeconds} s limit`],
										),
									]
								: []),
						],
					},
				)
			}),
		),
		h.p([h.Class("text-xs text-muted-foreground")], [intervalNote(form, current, timing)]),
	])
}

const slowdownOf = (model: Model): Pick<ConditionView, "slowedMinutes"> => {
	const row =
		model.editingRuleId === null
			? undefined
			: model.rules?.find((rule) => rule.id === model.editingRuleId)
	return { slowedMinutes: row?.slowed_interval_minutes ?? null }
}

/** Saving resets a slowdown, so say so while the picked interval is shorter than it. */
const slowdownNotice = (h: H, model: ConditionView, form: RuleForm): ReadonlyArray<Html> =>
	model.slowedMinutes === null || formIntervalMinutes(form) >= model.slowedMinutes
		? []
		: [
				h.div(
					[
						h.Class(
							"flex flex-wrap items-center justify-between gap-2 rounded-md border border-severity-warn/40 bg-severity-warn/10 px-3 py-2 text-xs",
						),
					],
					[
						h.span(
							[],
							[
								`Checked every ${model.slowedMinutes} min because its query kept hitting its limit. Saving resets this unless you keep it.`,
							],
						),
						button(
							h,
							{
								variant: "outline",
								size: "xs",
								attributes: [
									h.OnClick(
										Message.ClickedUseInterval({ minutes: String(model.slowedMinutes) }),
									),
								],
							},
							[`Keep ${model.slowedMinutes} min`],
						),
					],
				),
			]

const intervalNote = (
	form: RuleForm,
	option: ReturnType<typeof intervalOptions>[number] | undefined,
	timing: AlertQueryTiming | null,
): string => {
	if (option === undefined) return ""
	if (option.isLongerThanWindow) return "Longer than the window, so data between checks would go unread."
	if (form.signalType === "raw_query" && timing?.failure === "query_too_much_memory") {
		return "It ran out of memory with the most any interval allows, so checking less often will not help."
	}
	// Timed out, or too slow even for the longest limit: no interval helps.
	const fitsNoInterval =
		timing?.failure === "query_too_slow" ||
		(timing?.elapsedMs != null && alertIntervalsFitting(timing.elapsedMs).length === 0)
	if (form.signalType === "raw_query" && fitsNoInterval) {
		return "It needs longer than the longest limit any interval allows, so checking less often will not help."
	}
	if (option.isTooSlow) {
		return `Over or too close to the ${option.limitSeconds} s this interval allows. Checking less often allows a slower query.`
	}
	if (form.signalType !== "raw_query") {
		const auto = autoIntervalMinutes(form)
		return option.value === AUTO_INTERVAL || option.minutes === auto
			? "A fifth of the window, from every minute to every 5."
			: option.minutes > auto
				? "Fewer checks than Auto over the same window."
				: "More checks than Auto over the same window."
	}
	return `Each check may run ${option.limitSeconds} s. Checking less often allows a slower query.`
}

const checksSection = (
	h: H,
	model: ConditionView,
	form: RuleForm,
	saved: RuleForm | null,
	timing: AlertQueryTiming | null,
): Html => {
	const values = valuesOf(model, form, saved)
	return h.div(
		[h.Class("space-y-3 border-t p-4")],
		[
			eyebrow(h, { as: "h3" }, ["How it is checked"]),
			h.div(
				[h.Class("grid items-start gap-4 md:grid-cols-3")],
				[
					numberField(h, {
						id: "rule-window-minutes",
						label: "Window",
						description: windowDescription(form),
						unit: "min",
						onInput: changed("windowMinutes"),
						...values((f) => f.windowMinutes),
					}),
					h.div(
						[h.Class("grid grid-cols-2 items-start gap-3")],
						[
							numberField(h, {
								id: "rule-consecutive-breaches",
								label: "Breaches to fire",
								unit: "checks",
								onInput: changed("consecutiveBreachesRequired"),
								...values((f) => f.consecutiveBreachesRequired),
							}),
							numberField(h, {
								id: "rule-breaches-out-of",
								label: "Out of the last",
								placeholder: "In a row",
								unit: form.breachesOutOf.trim().length > 0 ? "checks" : null,
								onInput: changed("breachesOutOf"),
								...values((f) => f.breachesOutOf),
							}),
							h.p(
								[h.Class("col-span-2 -mt-1.5 text-xs text-muted-foreground")],
								["Empty counts them in a row. 1 fires on the first breach."],
							),
						],
					),
					numberField(h, {
						id: "rule-minimum-samples",
						label: "Minimum samples",
						description: "Windows with fewer are skipped and can't fire.",
						unit: "per window",
						onInput: changed("minimumSampleCount"),
						...values((f) => f.minimumSampleCount),
					}),
				],
			),
			intervalPicker(h, model, form, timing),
		],
	)
}

const condition = (h: H, model: ConditionView, form: RuleForm, timing: AlertQueryTiming | null): Html =>
	card(
		h,
		[
			comparatorRow(h, model, form, model.savedForm),
			thresholdsSection(h, model, form, model.savedForm),
			checksSection(h, model, form, model.savedForm, timing),
		],
		"gap-0 p-0",
	)

const thresholdsSection = (h: H, model: ConditionView, form: RuleForm, saved: RuleForm | null): Html => {
	const isRange = isRangeComparator(form.comparator)
	const isTiered = comparatorSupportsTiers(form.comparator)
	const escalation = isTiered ? form.escalation : null
	const unit = thresholdUnitLabel(form)
	const values = valuesOf(model, form, saved)
	const recovery = recoveryLabel(form.comparator)
	const escalationOf = (pick: (tier: NonNullable<RuleForm["escalation"]>) => string) =>
		values((f) => (f.escalation === null ? "" : pick(f.escalation)))
	return h.div(
		[h.Class("space-y-3 border-t p-4")],
		[
			eyebrow(h, { as: "h3" }, ["Thresholds"]),
			h.div(
				[h.Class("grid items-start gap-4 md:grid-cols-3")],
				[
					escalation === null ? severityPicker(h, form.severity) : tierLabel(h, "warning"),
					h.div(
						[h.Class(cn("grid items-start gap-3", isRange && "grid-cols-2"))],
						[
							numberField(h, {
								id: "rule-threshold",
								label: isRange ? "From" : "Threshold",
								unit,
								onInput: changed("threshold"),
								...values((f) => f.threshold),
							}),
							...(isRange
								? [
										numberField(h, {
											id: "rule-threshold-upper",
											label: "To",
											unit,
											onInput: changed("thresholdUpper"),
											...values((f) => f.thresholdUpper),
										}),
									]
								: []),
						],
					),
					...(isTiered
						? [
								numberField(h, {
									id: "rule-recovery",
									label: recovery,
									placeholder: "Threshold",
									description: "Optional. Empty clears once it's back past the threshold.",
									unit,
									onInput: changed("recoveryValue"),
									...values((f) => f.recoveryValue),
								}),
							]
						: []),
				],
			),
			...(escalation === null ? [] : [criticalRow(h, unit, recovery, escalationOf)]),
			...(isTiered && escalation === null && form.severity === "warning"
				? [
						button(
							h,
							{
								variant: "ghost",
								size: "sm",
								className: "-ml-2 px-2 text-xs text-muted-foreground",
								attributes: [h.OnClick(Message.ClickedAddCriticalTier())],
							},
							[icon(h, "PlusIcon", { size: 12 }), "Add critical tier"],
						),
					]
				: []),
		],
	)
}

const slot = createLazy()
const viewOf = stableSlice((model: Model): ConditionView => ({
	mountedForm: model.mountedForm,
	savedForm: model.savedForm,
	comparatorSelect: model.selects[COMPARATOR_SELECT_ID],
	...slowdownOf(model),
}))

/** The condition card under the chart; `form` is the evaluated draft (`evaluatedFormOf`). */
export const conditionFields = (h: H, model: Model, form: RuleForm): Html =>
	slot(condition, [h, viewOf(model), form, draftTimingOf(model, form)])
