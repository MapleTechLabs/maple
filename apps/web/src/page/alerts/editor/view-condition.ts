import type { AlertQueryTiming, AlertSeverity } from "@maple/domain/http"
import { alertIntervalsFitting } from "@maple/query-engine/datetime"
import {
	comparatorSupportsTiers,
	isRangeComparator,
	thresholdUnitLabel,
} from "@maple/web-data/alerts/form-utils"
import { cn } from "@maple/ui/lib/utils"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import * as RadioGroup from "@maple/views/ui/radio-group"
import { statusDot } from "@maple/views/ui/status-dot"
import type * as Select from "@maple/views/ui/select"
import { sentenceClause, sentencePhrase, sentenceRow, sentenceSection } from "../../kit/sentence-card"
import { stableSlice } from "../../kit/stable-slice"
import { COMPARATOR_WORDS, comparatorWords, recoveryLabel } from "./derive"
import { draftTimingOf, invalidFieldsOf } from "./derive-rows"
import type { RuleForm } from "./form"
import { BREACH_MODE_SELECT_ID } from "./form-steps"
import {
	AUTO_INTERVAL,
	autoIntervalMinutes,
	formIntervalMinutes,
	INTERVAL_SELECT_ID,
	type IntervalOption,
	intervalOptions,
	intervalSelectValue,
} from "./interval"
import { Message, type TextField } from "./message"
import type { Model } from "./model"
import { inlineNumber, wasLine } from "./view-fields"
import { formSelect } from "./view-select"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str, Option } from "effect"

// `RuleConditionFields`: the thresholds and how they are checked, each as a sentence.

type H = HtmlBuilder<Message>

const COMPARATOR_SELECT_ID = "rule-comparator"

/** What the card reads off the Model: the dirty and saved values, and its selects' state. */
type ConditionView = Pick<Model, "mountedForm" | "savedForm" | "isBreachWindowOpen"> &
	Readonly<{
		comparatorSelect: Select.Model | undefined
		intervalSelect: Select.Model | undefined
		breachModeSelect: Select.Model | undefined
		/** The edited rule's slowdown after query timeouts, which saving clears. */
		slowedMinutes: number | null
	}>

/** `COMPARATOR_ITEMS`, in `comparatorLabels` order. */
const COMPARATOR_ITEMS = Arr.map([...COMPARATOR_WORDS], ([value, label]) => ({ value, label }))

const SEVERITY_OPTIONS: ReadonlyArray<{
	value: AlertSeverity
	label: string
	selected: string
	dot: string
}> = [
	{
		value: "warning",
		label: "Warning",
		selected: "border-severity-warn/60 bg-severity-warn-a2 text-severity-warn",
		dot: "bg-severity-warn",
	},
	{
		value: "critical",
		label: "Critical",
		selected: "border-severity-error-a4 bg-severity-error-a2 text-severity-error",
		dot: "bg-severity-error",
	},
]

// One chip for a tier's severity, picked or fixed: 32px, 36px on a phone.
const SEVERITY_CHIP =
	"inline-flex h-9 shrink-0 select-none items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium sm:h-8"

/** `SeverityPicker`: the one tier's severity, as two chips. */
const severityPicker = (h: H, value: AlertSeverity): Html => {
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: RadioGroup.init(value),
		toParentMessage: (message) => Message.GotRadioMessage({ group: "severity", message }),
		items: Arr.map(SEVERITY_OPTIONS, (option) => ({
			value: option.value,
			id: `rule-severity-${option.value}`,
			inputId: `rule-severity-${option.value}-input`,
		})),
	}
	return hstack(
		h,
		{
			gap: "1",
			attributes: [h.AriaLabel("Severity"), h.DataAttribute("filled", ""), h.Role("radiogroup")],
		},
		Arr.flatMap(SEVERITY_OPTIONS, (option) => {
			const isSelected = value === option.value
			return RadioGroup.radio(
				h,
				config,
				option.value,
				cn(
					SEVERITY_CHIP,
					"cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					isSelected
						? option.selected
						: "border-border text-muted-foreground hover:border-border-strong active:border-border-strong hover:text-foreground active:text-foreground",
				),
				{
					children: [
						statusDot(h, {
							tone: "custom",
							className: isSelected ? option.dot : "bg-foreground-faint",
						}),
						option.label,
					],
				},
			)
		}),
	)
}

/** `TierLabel`: the fixed severity of a row once a rule has two tiers, the same chip as the picker's. */
const tierLabel = (h: H, severity: AlertSeverity): Html => {
	const option = Option.getOrElse(
		Arr.findFirst(SEVERITY_OPTIONS, (candidate) => candidate.value === severity),
		() => SEVERITY_OPTIONS[0],
	)
	return h.span(
		[h.Class(cn(SEVERITY_CHIP, option?.selected))],
		[statusDot(h, { tone: "custom", className: option?.dot ?? "" }), option?.label ?? ""],
	)
}

/** The saved value of a field when the draft changed it (`was`). */
const wasOf = (saved: RuleForm | null, form: RuleForm, pick: (form: RuleForm) => string): string | null =>
	saved !== null && Str.trim(pick(saved)) !== Str.trim(pick(form)) ? pick(saved) : null

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

const help = (h: H, text: string): Html => typography(h, { size: "xs", tone: "muted", as: "p" }, [text])

/** The comparator without its "is": "above", "below", "between". */
const bareComparator = (form: RuleForm): string => Str.replace(/^is /, "")(comparatorWords(form.comparator))

const thresholdsSection = (
	h: H,
	model: ConditionView,
	form: RuleForm,
	saved: RuleForm | null,
	invalid: ReadonlySet<string>,
): Html => {
	const isRange = isRangeComparator(form.comparator)
	const isTiered = comparatorSupportsTiers(form.comparator)
	const escalation = isTiered ? form.escalation : null
	const unit = thresholdUnitLabel(form)
	const values = valuesOf(model, form, saved)
	const recovery = Str.toLowerCase(recoveryLabel(form.comparator))
	const escalationOf = (pick: (tier: NonNullable<RuleForm["escalation"]>) => string) =>
		values((f) => (f.escalation === null ? "" : pick(f.escalation)))
	const comparatorWas = wasOf(saved, form, (f) => f.comparator)
	const threshold = values((f) => f.threshold)
	const upper = values((f) => f.thresholdUpper)
	const recoveryValue = values((f) => f.recoveryValue)
	const criticalThreshold = escalationOf((tier) => tier.threshold)
	const criticalRecovery = escalationOf((tier) => tier.recoveryValue)
	// An empty recovery clears at the threshold itself, so that is what the empty field shows.
	const recoveryPlaceholder = (value: string) => (Str.trim(value).length > 0 ? Str.trim(value) : "same")
	return sentenceSection(h, { title: "Thresholds" }, [
		sentenceClause(
			h,
			sentenceRow(h, {}, [
				escalation === null ? severityPicker(h, form.severity) : tierLabel(h, "warning"),
				"when the value",
				formSelect(
					h,
					model.comparatorSelect,
					COMPARATOR_SELECT_ID,
					form.comparator,
					COMPARATOR_ITEMS,
					{
						className: cn("w-auto", comparatorWas !== null && "border-severity-warn/60"),
						ariaLabel: "Condition",
						toView: (parts) => h.span([h.Class("contents")], parts),
					},
				),
				inlineNumber(h, {
					id: "rule-threshold",
					ariaLabel: isRange ? "From" : "Threshold",
					unit,
					isInvalid: invalid.has("rule-threshold"),
					onInput: changed("threshold"),
					...threshold,
				}),
				...(isRange
					? [
							sentencePhrase(h, [
								"and",
								inlineNumber(h, {
									id: "rule-threshold-upper",
									ariaLabel: "To",
									unit,
									isInvalid: invalid.has("rule-threshold-upper"),
									onInput: changed("thresholdUpper"),
									...upper,
								}),
							]),
						]
					: []),
				...(isTiered
					? [
							sentencePhrase(h, [
								`and ${recovery}`,
								inlineNumber(h, {
									id: "rule-recovery",
									ariaLabel: recoveryLabel(form.comparator),
									placeholder: recoveryPlaceholder(form.threshold),
									unit,
									isInvalid: invalid.has("rule-recovery"),
									onInput: changed("recoveryValue"),
									...recoveryValue,
								}),
							]),
						]
					: []),
			]),
			[
				...wasLine(h, [
					{
						label: "Condition",
						previous:
							comparatorWas === null
								? null
								: comparatorWords(saved?.comparator ?? form.comparator),
					},
					{ label: isRange ? "From" : "Threshold", previous: threshold.previous, unit },
					{ label: "To", previous: isRange ? upper.previous : null, unit },
					{
						label: recoveryLabel(form.comparator),
						previous: isTiered ? recoveryValue.previous : null,
						unit,
					},
				]),
				...(isTiered
					? [
							help(
								h,
								"Recovery is optional. Left empty, it clears once it's back past the threshold.",
							),
						]
					: []),
				...(!isTiered && form.escalation !== null
					? [help(h, "This condition has one tier, so the critical tier is dropped on save.")]
					: []),
			],
		),
		...(escalation === null
			? []
			: [
					sentenceClause(
						h,
						sentenceRow(h, {}, [
							tierLabel(h, "critical"),
							bareComparator(form),
							inlineNumber(h, {
								id: "rule-critical-threshold",
								ariaLabel: "Critical threshold",
								unit,
								isInvalid: invalid.has("rule-critical-threshold"),
								onInput: (value) =>
									Message.ChangedEscalationField({ field: "threshold", value }),
								...criticalThreshold,
							}),
							sentencePhrase(h, [
								`and ${recovery}`,
								inlineNumber(h, {
									id: "rule-critical-recovery",
									ariaLabel: `Critical ${recovery}`,
									placeholder: recoveryPlaceholder(escalation.threshold),
									unit,
									isInvalid: invalid.has("rule-critical-recovery"),
									onInput: (value) =>
										Message.ChangedEscalationField({ field: "recoveryValue", value }),
									...criticalRecovery,
								}),
							]),
							button(
								h,
								{
									variant: "ghost",
									attributes: [h.OnClick(Message.ClickedRemoveCriticalTier())],
								},
								["Remove"],
							),
						]),
						[
							...wasLine(h, [
								{ label: "Critical threshold", previous: criticalThreshold.previous, unit },
								{ label: `Critical ${recovery}`, previous: criticalRecovery.previous, unit },
							]),
							help(h, "A critical that recovers drops back to warning."),
						],
					),
				]),
		...(isTiered && escalation === null && form.severity === "warning"
			? [
					hstack(h, {}, [
						button(
							h,
							{
								variant: "ghost",
								className: "-ml-2",
								attributes: [h.OnClick(Message.ClickedAddCriticalTier())],
							},
							[icon(h, "PlusIcon", { size: 12 }), "Add critical tier"],
						),
					]),
				]
			: []),
	])
}

/** What a check reads and how often the scheduler runs one. */
const windowDescription = (form: RuleForm): string => {
	const minutes = Number(Str.trim(form.windowMinutes))
	if (!Number.isFinite(minutes) || minutes <= 0) return "Each check looks at this much data."
	const every = formIntervalMinutes(form)
	return `Each check looks at this much data, checked every ${every === 1 ? "minute" : `${every} min`}.`
}

/** An interval as the list shows it: why it will not work, and for raw SQL the time it allows. */
const intervalItemLabel = (option: IntervalOption, isRaw: boolean): string =>
	Arr.join(
		[
			option.label,
			...(isRaw ? [`${option.limitSeconds} s limit`] : []),
			...(option.isLongerThanWindow
				? ["longer than the window"]
				: option.isTooSlow
					? ["too slow for this query"]
					: []),
		],
		" · ",
	)

/** "every [interval]": a select inside the sentence, at its content's width. */
const intervalSelect = (
	h: H,
	model: ConditionView,
	form: RuleForm,
	options: ReadonlyArray<IntervalOption>,
): Html => {
	const isRaw = form.signalType === "raw_query"
	const selected = intervalSelectValue(form.evaluationIntervalMinutes)
	const current = Arr.findFirst(options, (option) => option.value === selected)
	const isBlocked = Option.exists(current, (option) => option.isLongerThanWindow || option.isTooSlow)
	return formSelect(
		h,
		model.intervalSelect,
		INTERVAL_SELECT_ID,
		selected,
		Arr.map(options, (option) => ({ value: option.value, label: intervalItemLabel(option, isRaw) })),
		{
			className: cn("w-auto", isBlocked && "border-severity-warn/60"),
			ariaLabel: "Check every",
			// The trigger keeps the short name; the list says each option's limit and why it is blocked.
			renderValue: (value) => [
				Option.match(
					Arr.findFirst(options, (option) => option.value === value),
					{ onNone: () => value, onSome: (option) => option.label },
				),
			],
			toView: (parts) => h.span([h.Class("contents")], parts),
		},
	)
}

const slowdownOf = (model: Model): Pick<ConditionView, "slowedMinutes"> => {
	const row =
		model.editingRuleId === null
			? Option.none()
			: Arr.findFirst(model.rules ?? [], (rule) => rule.id === model.editingRuleId)
	return {
		slowedMinutes: Option.getOrNull(Option.flatMapNullishOr(row, (rule) => rule.slowed_interval_minutes)),
	}
}

/** Saving resets a slowdown, so say so while the picked interval is shorter than it. */
const slowdownNotice = (h: H, model: ConditionView, form: RuleForm): ReadonlyArray<Html> =>
	model.slowedMinutes === null || formIntervalMinutes(form) >= model.slowedMinutes
		? []
		: [
				hstack(
					h,
					{
						gap: "2",
						align: "center",
						justify: "between",
						wrap: true,
						className:
							"rounded-md border border-severity-warn-a4 bg-severity-warn-a2 px-3 py-2 text-xs",
					},
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
	found: Option.Option<IntervalOption>,
	timing: AlertQueryTiming | null,
): string => {
	if (Option.isNone(found)) return ""
	const option = found.value
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
			? "Auto checks every fifth of the window, from every minute to every 5."
			: option.minutes > auto
				? "Fewer checks than Auto over the same window."
				: "More checks than Auto over the same window."
	}
	return `Each check may run ${option.limitSeconds} s. Checking less often allows a slower query.`
}

const BREACH_MODE_ITEMS = [
	{ value: "row", label: "in a row" },
	{ value: "window", label: "out of the last" },
]

const checksSection = (
	h: H,
	model: ConditionView,
	form: RuleForm,
	saved: RuleForm | null,
	timing: AlertQueryTiming | null,
	invalid: ReadonlySet<string>,
): Html => {
	const values = valuesOf(model, form, saved)
	const isRaw = form.signalType === "raw_query"
	const options = intervalOptions(form, isRaw ? timing : null)
	const current = Arr.findFirst(
		options,
		(option) => option.value === intervalSelectValue(form.evaluationIntervalMinutes),
	)
	const hasBreachWindow = model.isBreachWindowOpen || Str.trim(form.breachesOutOf).length > 0
	const windowMinutes = values((f) => f.windowMinutes)
	const breaches = values((f) => f.consecutiveBreachesRequired)
	const outOf = values((f) => f.breachesOutOf)
	const samples = values((f) => f.minimumSampleCount)
	return sentenceSection(h, { title: "How it is checked" }, [
		sentenceClause(
			h,
			sentenceRow(h, {}, [
				"Look at the last",
				inlineNumber(h, {
					id: "rule-window-minutes",
					ariaLabel: "Window",
					isInvalid: invalid.has("rule-window-minutes"),
					onInput: changed("windowMinutes"),
					...windowMinutes,
				}),
				sentencePhrase(h, ["min, every", intervalSelect(h, model, form, options)]),
			]),
			[
				...slowdownNotice(h, model, form),
				...wasLine(h, [{ label: "Window", previous: windowMinutes.previous, unit: "min" }]),
				help(h, windowDescription(form)),
				help(h, intervalNote(form, current, timing)),
			],
		),
		sentenceClause(
			h,
			sentenceRow(h, {}, [
				"Fire after",
				inlineNumber(h, {
					id: "rule-consecutive-breaches",
					ariaLabel: "Breaches to fire",
					isInvalid: invalid.has("rule-consecutive-breaches"),
					onInput: changed("consecutiveBreachesRequired"),
					...breaches,
				}),
				"breaches",
				formSelect(
					h,
					model.breachModeSelect,
					BREACH_MODE_SELECT_ID,
					hasBreachWindow ? "window" : "row",
					BREACH_MODE_ITEMS,
					{
						className: "w-auto",
						ariaLabel: "How breaches are counted",
						toView: (parts) => h.span([h.Class("contents")], parts),
					},
				),
				...(hasBreachWindow
					? [
							inlineNumber(h, {
								id: "rule-breaches-out-of",
								ariaLabel: "Out of the last",
								inputMode: "numeric",
								isInvalid: invalid.has("rule-breaches-out-of"),
								onInput: changed("breachesOutOf"),
								...outOf,
							}),
							"checks.",
						]
					: []),
			]),
			[
				...wasLine(h, [
					{ label: "Breaches to fire", previous: breaches.previous },
					{ label: "Out of the last", previous: outOf.previous },
				]),
				help(h, "1 fires on the first breach."),
			],
		),
		sentenceClause(
			h,
			sentenceRow(h, {}, [
				"Skip windows with fewer than",
				inlineNumber(h, {
					id: "rule-minimum-samples",
					ariaLabel: "Minimum samples",
					isInvalid: invalid.has("rule-minimum-samples"),
					onInput: changed("minimumSampleCount"),
					...samples,
				}),
				"samples.",
			]),
			[
				...wasLine(h, [{ label: "Minimum samples", previous: samples.previous }]),
				help(h, "A skipped window can't fire."),
			],
		),
	])
}

const condition = (
	h: H,
	model: ConditionView,
	form: RuleForm,
	timing: AlertQueryTiming | null,
	invalidIds: string,
): Html => {
	const invalid = new Set(Str.split(invalidIds, ","))
	return h.div(
		[h.Class("contents")],
		[
			thresholdsSection(h, model, form, model.savedForm, invalid),
			checksSection(h, model, form, model.savedForm, timing, invalid),
		],
	)
}

const slot = createLazy()
const viewOf = stableSlice((model: Model): ConditionView => ({
	mountedForm: model.mountedForm,
	savedForm: model.savedForm,
	isBreachWindowOpen: model.isBreachWindowOpen,
	comparatorSelect: model.selects[COMPARATOR_SELECT_ID],
	intervalSelect: model.selects[INTERVAL_SELECT_ID],
	breachModeSelect: model.selects[BREACH_MODE_SELECT_ID],
	...slowdownOf(model),
}))

/** The thresholds and the checks; `form` is the evaluated draft (`evaluatedFormOf`). */
export const conditionFields = (h: H, model: Model, form: RuleForm): Html =>
	slot(condition, [h, viewOf(model), form, draftTimingOf(model, form), invalidFieldsOf(model, form)])
