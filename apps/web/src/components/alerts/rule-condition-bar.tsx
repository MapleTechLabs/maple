import type { Dispatch, ReactNode, SetStateAction } from "react"

import type { AlertComparator, AlertSeverity } from "@maple/domain/http"
import { Card } from "@maple/ui/components/ui/card"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@maple/ui/components/ui/input-group"
import { RadioGroupPrimitive, RadioPrimitive } from "@maple/ui/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { cn } from "@maple/ui/lib/utils"

import { Button } from "@maple/ui/components/ui/button"

import { PlusIcon } from "@/components/icons"
import {
	comparatorLabels,
	comparatorSupportsTiers,
	isRangeComparator,
	signalLabels,
	thresholdUnitLabel,
	type EscalationTierForm,
	type RuleFormState,
} from "@/lib/alerts/form-utils"

const NUMERIC_CONTROL_CLASS =
	"font-mono tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"

const COMPARATOR_WORDS: Record<AlertComparator, string> = {
	gt: "is above",
	gte: "is at or above",
	lt: "is below",
	lte: "is at or below",
	eq: "equals",
	neq: "is not",
	between: "is between",
	not_between: "is outside",
} satisfies Record<AlertComparator, string>

const COMPARATOR_ITEMS = (Object.keys(comparatorLabels) as AlertComparator[]).map((value) => ({
	value,
	label: COMPARATOR_WORDS[value],
}))

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

/** What the threshold is compared against, in words: the aggregation for a query, the signal otherwise. */
export function conditionSubject(form: RuleFormState): string {
	if (form.signalType === "raw_query") return "the SQL value"
	if (form.signalType === "builder_query") {
		const aggregation = form.queryBuilderDraft.aggregation.replaceAll("_", " ").trim()
		return aggregation.length > 0 ? aggregation : "the query value"
	}
	return signalLabels[form.signalType].toLowerCase()
}

/** The rule in one plain sentence, shown in the action bar so the whole rule reads at a glance. */
export function describeRuleCondition(form: RuleFormState): string {
	const unit = thresholdUnitLabel(form) ?? ""
	const value = (raw: string) => `${raw.trim() || "?"}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`
	const threshold = isRangeComparator(form.comparator)
		? `${value(form.threshold)} and ${value(form.thresholdUpper)}`
		: value(form.threshold)
	const escalation = comparatorSupportsTiers(form.comparator) ? form.escalation : null
	const checks = form.consecutiveBreachesRequired.trim() || "?"
	const outOf = form.breachesOutOf.trim()
	const windowText = `${form.windowMinutes.trim() || "?"} min`
	const when =
		outOf.length > 0
			? `in ${checks} of the last ${outOf} checks (${windowText} each)`
			: checks === "1"
				? `over ${windowText}`
				: `in ${checks} checks in a row (${windowText} each)`
	const severity = escalation === null && form.severity === "critical" ? "Critical" : "Warning"
	const critical =
		escalation === null
			? ""
			: `, critical ${COMPARATOR_WORDS[form.comparator].replace(/^is /, "")} ${value(escalation.threshold)},`
	return `${severity} when ${conditionSubject(form)} ${COMPARATOR_WORDS[form.comparator]} ${threshold}${critical} ${when}`
}

/** What crossing back looks like for a comparator, as the recovery field's label. */
function recoveryLabel(comparator: AlertComparator): string {
	return comparator === "gt" || comparator === "gte" ? "Recovers below" : "Recovers above"
}

/** A starting critical value one step worse than the warning one, so the new row is never blank. */
function suggestCriticalThreshold(form: RuleFormState): string {
	const warning = Number(form.threshold)
	if (form.threshold.trim().length === 0 || !Number.isFinite(warning)) return ""
	// One step of the warning's own size (1 at zero) in the breaching direction,
	// so the suggestion is always worse than the warning, whatever its sign.
	const step = Math.abs(warning) || 1
	const worse = form.comparator === "gt" || form.comparator === "gte" ? warning + step : warning - step
	return String(Number(worse.toPrecision(12)))
}

interface RuleConditionFieldsProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	/** The saved rule while editing: a changed field says what it was. */
	saved: RuleFormState | null
}

/** Condition, one row per severity tier and the evaluation fields under the chart; each redraws it. */
export function RuleConditionFields({ form, onChange, saved }: RuleConditionFieldsProps) {
	const rangeMode = isRangeComparator(form.comparator)
	const tiered = comparatorSupportsTiers(form.comparator)
	const escalation = tiered ? form.escalation : null
	const unit = thresholdUnitLabel(form)
	const was = (pick: (f: RuleFormState) => string) =>
		saved !== null && pick(saved).trim() !== pick(form).trim() ? pick(saved) : null
	const comparatorWas = was((f) => f.comparator)
	const setEscalation = (patch: Partial<EscalationTierForm>) =>
		onChange((c) => (c.escalation === null ? c : { ...c, escalation: { ...c.escalation, ...patch } }))

	return (
		<Card className="gap-0 p-0">
			<div className="grid items-start gap-4 p-4 md:grid-cols-3">
				<Field className="items-stretch gap-1.5">
					<FieldLabel>Alert when the value</FieldLabel>
					<Select
						items={COMPARATOR_ITEMS}
						value={form.comparator}
						onValueChange={(value) => value && onChange((c) => ({ ...c, comparator: value }))}
					>
						<SelectTrigger
							aria-label="Condition"
							className={cn("h-9 w-full", comparatorWas !== null && "border-severity-warn/60")}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{COMPARATOR_ITEMS.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{comparatorWas !== null && (
						<WasNote>{COMPARATOR_WORDS[saved?.comparator ?? form.comparator]}</WasNote>
					)}
				</Field>
				{!tiered && form.escalation !== null && (
					<p className="text-xs text-muted-foreground md:col-span-2 md:pt-7">
						This condition has one tier, so the critical tier is dropped on save.
					</p>
				)}
			</div>

			<div className="space-y-3 border-t p-4">
				<Eyebrow as="h3">Thresholds</Eyebrow>
				<div className="grid items-start gap-4 md:grid-cols-3">
					{escalation === null ? (
						<SeverityPicker
							value={form.severity}
							onChange={(severity) => onChange((c) => ({ ...c, severity }))}
						/>
					) : (
						<TierLabel severity="warning" />
					)}
					<div className={cn("grid items-start gap-3", rangeMode && "grid-cols-2")}>
						<NumberField
							id="rule-threshold"
							label={rangeMode ? "From" : "Threshold"}
							value={form.threshold}
							unit={unit}
							previous={was((f) => f.threshold)}
							onChange={(value) => onChange((c) => ({ ...c, threshold: value }))}
						/>
						{rangeMode && (
							<NumberField
								id="rule-threshold-upper"
								label="To"
								value={form.thresholdUpper}
								unit={unit}
								previous={was((f) => f.thresholdUpper)}
								onChange={(value) => onChange((c) => ({ ...c, thresholdUpper: value }))}
							/>
						)}
					</div>
					{tiered && (
						<NumberField
							id="rule-recovery"
							label={recoveryLabel(form.comparator)}
							placeholder="Threshold"
							description="Optional. Empty clears once it's back past the threshold."
							value={form.recoveryValue}
							unit={unit}
							previous={was((f) => f.recoveryValue)}
							onChange={(value) => onChange((c) => ({ ...c, recoveryValue: value }))}
						/>
					)}
				</div>

				{escalation !== null && (
					<div className="grid items-start gap-4 border-t pt-3 md:grid-cols-3">
						<div className="flex items-center justify-between gap-2">
							<TierLabel severity="critical" />
							<Button
								variant="ghost"
								size="sm"
								className="mt-6 h-7 px-2 text-xs text-muted-foreground"
								onClick={() => onChange((c) => ({ ...c, escalation: null }))}
							>
								Remove
							</Button>
						</div>
						<NumberField
							id="rule-critical-threshold"
							label="Threshold"
							ariaLabel="Critical threshold"
							value={escalation.threshold}
							unit={unit}
							previous={was((f) => f.escalation?.threshold ?? "")}
							onChange={(value) => setEscalation({ threshold: value })}
						/>
						<NumberField
							id="rule-critical-recovery"
							label={recoveryLabel(form.comparator)}
							ariaLabel={`Critical ${recoveryLabel(form.comparator).toLowerCase()}`}
							placeholder="Threshold"
							description="A critical that recovers drops back to warning."
							value={escalation.recoveryValue}
							unit={unit}
							previous={was((f) => f.escalation?.recoveryValue ?? "")}
							onChange={(value) => setEscalation({ recoveryValue: value })}
						/>
					</div>
				)}

				{tiered && escalation === null && form.severity === "warning" && (
					<Button
						variant="ghost"
						size="sm"
						className="-ml-2 h-7 px-2 text-xs text-muted-foreground"
						onClick={() =>
							onChange((c) => ({
								...c,
								severity: "warning",
								escalation: {
									threshold: suggestCriticalThreshold(c),
									recoveryValue: "",
									destinationIds: [],
								},
							}))
						}
					>
						<PlusIcon size={12} />
						Add critical tier
					</Button>
				)}
			</div>

			<div className="space-y-3 border-t p-4">
				<Eyebrow as="h3">How it is checked</Eyebrow>
				<div className="grid items-start gap-4 md:grid-cols-3">
					<NumberField
						id="rule-window-minutes"
						label="Window"
						description="Each check looks at this much data."
						value={form.windowMinutes}
						unit="min"
						previous={was((f) => f.windowMinutes)}
						onChange={(value) => onChange((c) => ({ ...c, windowMinutes: value }))}
					/>
					<div className="grid grid-cols-2 items-start gap-3">
						<NumberField
							id="rule-consecutive-breaches"
							label="Breaches to fire"
							value={form.consecutiveBreachesRequired}
							unit="checks"
							previous={was((f) => f.consecutiveBreachesRequired)}
							onChange={(value) =>
								onChange((c) => ({ ...c, consecutiveBreachesRequired: value }))
							}
						/>
						<NumberField
							id="rule-breaches-out-of"
							label="Out of the last"
							placeholder="In a row"
							value={form.breachesOutOf}
							unit={form.breachesOutOf.trim().length > 0 ? "checks" : null}
							previous={was((f) => f.breachesOutOf)}
							onChange={(value) => onChange((c) => ({ ...c, breachesOutOf: value }))}
						/>
						<p className="col-span-2 -mt-1.5 text-xs text-muted-foreground">
							Empty counts them in a row. 1 fires on the first breach.
						</p>
					</div>
					<NumberField
						id="rule-minimum-samples"
						label="Minimum samples"
						description="Windows with fewer are skipped and can't fire."
						value={form.minimumSampleCount}
						unit="per window"
						previous={was((f) => f.minimumSampleCount)}
						onChange={(value) => onChange((c) => ({ ...c, minimumSampleCount: value }))}
					/>
				</div>
			</div>
		</Card>
	)
}

function SeverityPicker({
	value,
	onChange,
}: {
	value: AlertSeverity
	onChange: (value: AlertSeverity) => void
}) {
	return (
		<Field className="items-stretch gap-1.5">
			<FieldLabel id="rule-severity-label">Severity</FieldLabel>
			<RadioGroupPrimitive
				value={value}
				onValueChange={(next: AlertSeverity) => onChange(next)}
				aria-labelledby="rule-severity-label"
				className="grid grid-cols-2 gap-1 rounded-md bg-muted/30 p-0.5"
			>
				{SEVERITY_OPTIONS.map((option) => {
					const selected = value === option.value
					return (
						<RadioPrimitive.Root
							key={option.value}
							value={option.value}
							className={cn(
								"inline-flex h-8 cursor-pointer select-none items-center justify-center gap-1.5 rounded-sm border border-transparent px-2.5 text-xs font-medium",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								selected
									? option.selected
									: "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
							)}
						>
							<StatusDot
								tone="custom"
								className={selected ? option.dot : "bg-muted-foreground/40"}
							/>
							{option.label}
						</RadioPrimitive.Root>
					)
				})}
			</RadioGroupPrimitive>
		</Field>
	)
}

/** The fixed severity of a row once a rule has two tiers. */
function TierLabel({ severity }: { severity: AlertSeverity }) {
	const option = SEVERITY_OPTIONS.find((o) => o.value === severity) ?? SEVERITY_OPTIONS[0]!
	return (
		<Field className="items-stretch gap-1.5">
			<FieldLabel>Severity</FieldLabel>
			<span
				className={cn(
					"inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium",
					option.selected,
				)}
			>
				<StatusDot tone="custom" className={option.dot} />
				{option.label}
			</span>
		</Field>
	)
}

function WasNote({ children }: { children: ReactNode }) {
	return (
		<p className="text-xs text-severity-warn">
			Was <span className="font-mono">{children}</span>
		</p>
	)
}

function NumberField({
	id,
	label,
	description,
	placeholder,
	ariaLabel,
	value,
	unit,
	previous,
	onChange,
}: {
	id: string
	label: string
	description?: string
	placeholder?: string
	/** Names the input apart from its visible label, where two rows share one. */
	ariaLabel?: string
	value: string
	unit: string | null
	/** The saved value when it differs. */
	previous: string | null
	onChange: (value: string) => void
}) {
	return (
		<Field className="items-stretch gap-1.5">
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<InputGroup className={cn("h-9", previous !== null && "border-severity-warn/60")}>
				<InputGroupInput
					id={id}
					type="number"
					inputMode="decimal"
					value={value}
					placeholder={placeholder}
					aria-label={ariaLabel}
					onChange={(event) => onChange(event.target.value)}
					controlClassName={NUMERIC_CONTROL_CLASS}
				/>
				{unit !== null && (
					<InputGroupAddon align="inline-end">
						<InputGroupText>{unit}</InputGroupText>
					</InputGroupAddon>
				)}
			</InputGroup>
			{previous !== null ? (
				<WasNote>
					{previous.length > 0 ? previous : "none"}
					{previous.length > 0 && unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}
				</WasNote>
			) : (
				description && <FieldDescription>{description}</FieldDescription>
			)}
		</Field>
	)
}
