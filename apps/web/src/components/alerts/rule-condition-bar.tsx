import type { Dispatch, SetStateAction } from "react"

import type { AlertComparator, AlertSeverity } from "@maple/domain/http"
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
	thresholdUnitLabel,
	type RuleFormState,
} from "@/lib/alerts/form-utils"

/* Strip the native number spinners: the bar reads as a sentence, not a stepper. */
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

interface RuleConditionBarProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	/** The saved rule while editing: a changed field shows its old value struck through. */
	saved: RuleFormState | null
}

/**
 * The rule's condition as one sentence under the preview chart: "Alert when
 * the value is above 5% over 5 min in 2 checks in a row". Every field here
 * redraws the threshold line or the would-fire bands above it.
 */
export function RuleConditionBar({ form, onChange, saved }: RuleConditionBarProps) {
	const rangeMode = isRangeComparator(form.comparator)
	const unit = thresholdUnitLabel(form)
	const was = (pick: (f: RuleFormState) => string) =>
		saved !== null && pick(saved).trim() !== pick(form).trim() ? pick(saved) : null

	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
			<span className="text-muted-foreground">Alert when the value</span>
			<Select
				items={COMPARATOR_ITEMS}
				value={form.comparator}
				onValueChange={(value) => value && onChange((c) => ({ ...c, comparator: value }))}
			>
				<SelectTrigger
					aria-label="Condition"
					className={cn(
						"h-8 w-auto min-w-0",
						was((f) => f.comparator) !== null && "border-severity-warn/60",
					)}
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
			<ConditionInput
				id="rule-threshold"
				label={rangeMode ? "Lower threshold" : "Threshold"}
				value={form.threshold}
				unit={unit}
				previous={was((f) => f.threshold)}
				onChange={(value) => onChange((c) => ({ ...c, threshold: value }))}
			/>
			{rangeMode && (
				<>
					<span className="text-muted-foreground">and</span>
					<ConditionInput
						id="rule-threshold-upper"
						label="Upper threshold"
						value={form.thresholdUpper}
						unit={unit}
						previous={was((f) => f.thresholdUpper)}
						onChange={(value) => onChange((c) => ({ ...c, thresholdUpper: value }))}
					/>
				</>
			)}
			<span className="text-muted-foreground">over</span>
			<ConditionInput
				id="rule-window-minutes"
				label="Window"
				value={form.windowMinutes}
				unit="min"
				previous={was((f) => f.windowMinutes)}
				onChange={(value) => onChange((c) => ({ ...c, windowMinutes: value }))}
			/>
			<span className="text-muted-foreground">in</span>
			<ConditionInput
				id="rule-consecutive-breaches"
				label="Checks to fire"
				value={form.consecutiveBreachesRequired}
				unit="checks in a row"
				previous={was((f) => f.consecutiveBreachesRequired)}
				onChange={(value) => onChange((c) => ({ ...c, consecutiveBreachesRequired: value }))}
				narrow
			/>
			<span className="text-muted-foreground">with at least</span>
			<ConditionInput
				id="rule-minimum-samples"
				label="Min samples"
				value={form.minimumSampleCount}
				unit="samples"
				previous={was((f) => f.minimumSampleCount)}
				onChange={(value) => onChange((c) => ({ ...c, minimumSampleCount: value }))}
			/>
			<div className="ml-auto flex items-center gap-2">
				<span id="rule-severity-label" className="text-muted-foreground">
					as
				</span>
				<RadioGroupPrimitive
					value={form.severity}
					onValueChange={(value: AlertSeverity) => onChange((c) => ({ ...c, severity: value }))}
					aria-labelledby="rule-severity-label"
					className="inline-flex items-center gap-1 rounded-md bg-muted/30 p-0.5"
				>
					{SEVERITY_OPTIONS.map((option) => {
						const selected = form.severity === option.value
						return (
							<RadioPrimitive.Root
								key={option.value}
								value={option.value}
								className={cn(
									"inline-flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-sm border border-transparent px-2.5 text-xs font-medium",
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
			</div>
		</div>
	)
}

function ConditionInput({
	id,
	label,
	value,
	unit,
	previous,
	onChange,
	narrow = false,
}: {
	id: string
	label: string
	value: string
	unit: string | null
	/** The saved value when it differs, struck through inside the field. */
	previous: string | null
	onChange: (value: string) => void
	/** Small counts (checks) need less room than thresholds. */
	narrow?: boolean
}) {
	return (
		<InputGroup className={cn("h-8 w-auto", previous !== null && "border-severity-warn/60")}>
			{previous !== null && (
				<InputGroupAddon align="inline-start">
					<InputGroupText className="font-mono text-muted-foreground line-through">
						{previous.length > 0 ? previous : "none"}
					</InputGroupText>
				</InputGroupAddon>
			)}
			<InputGroupInput
				id={id}
				aria-label={label}
				type="number"
				inputMode="decimal"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				className={narrow ? "w-10" : "w-16"}
				controlClassName={NUMERIC_CONTROL_CLASS}
			/>
			{unit !== null && (
				<InputGroupAddon align="inline-end">
					<InputGroupText>{unit}</InputGroupText>
				</InputGroupAddon>
			)}
		</InputGroup>
	)
}
