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

import {
	comparatorLabels,
	isRangeComparator,
	signalLabels,
	thresholdUnitLabel,
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
	const checks = form.consecutiveBreachesRequired.trim() || "?"
	const windowText = `${form.windowMinutes.trim() || "?"} min`
	const when = checks === "1" ? `over ${windowText}` : `in ${checks} checks in a row (${windowText} each)`
	return `${form.severity === "critical" ? "Critical" : "Warning"} when ${conditionSubject(form)} ${COMPARATOR_WORDS[form.comparator]} ${threshold} ${when}`
}

interface RuleConditionFieldsProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	/** The saved rule while editing: a changed field says what it was. */
	saved: RuleFormState | null
}

/** Threshold, severity and evaluation as labeled fields in a grid under the chart; each redraws it. */
export function RuleConditionFields({ form, onChange, saved }: RuleConditionFieldsProps) {
	const rangeMode = isRangeComparator(form.comparator)
	const unit = thresholdUnitLabel(form)
	const was = (pick: (f: RuleFormState) => string) =>
		saved !== null && pick(saved).trim() !== pick(form).trim() ? pick(saved) : null
	const comparatorWas = was((f) => f.comparator)

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

				<Field className="items-stretch gap-1.5">
					<FieldLabel id="rule-severity-label">Severity</FieldLabel>
					<RadioGroupPrimitive
						value={form.severity}
						onValueChange={(value: AlertSeverity) => onChange((c) => ({ ...c, severity: value }))}
						aria-labelledby="rule-severity-label"
						className="grid grid-cols-2 gap-1 rounded-md bg-muted/30 p-0.5"
					>
						{SEVERITY_OPTIONS.map((option) => {
							const selected = form.severity === option.value
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
				<NumberField
					id="rule-consecutive-breaches"
					label="Checks in a row to fire"
					description="1 fires on the first breach. Higher is quieter."
					value={form.consecutiveBreachesRequired}
					unit="checks"
					previous={was((f) => f.consecutiveBreachesRequired)}
					onChange={(value) => onChange((c) => ({ ...c, consecutiveBreachesRequired: value }))}
				/>
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
	value,
	unit,
	previous,
	onChange,
}: {
	id: string
	label: string
	description?: string
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
