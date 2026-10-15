import type { Dispatch, SetStateAction } from "react"

import { Card } from "@maple/ui/components/ui/card"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@maple/ui/components/ui/input-group"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { Switch } from "@maple/ui/components/ui/switch"

import { ruleFormIsGrouped, type RuleFormState } from "@/lib/alerts/form-utils"

interface RuleNoiseSectionProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
}

/** How an open incident behaves once it fires: when it resolves, how often it repeats, what no data means. */
export function RuleNoiseSection({ form, onChange }: RuleNoiseSectionProps) {
	const grouped = ruleFormIsGrouped(form)
	return (
		<Card className="gap-0 p-0">
			<div className="space-y-3 p-4">
				<Eyebrow as="h3">After it fires</Eyebrow>
				<div className="grid items-start gap-4 md:grid-cols-3">
					<NoiseRow
						id="rule-consecutive-healthy"
						label="Resolve after"
						unit="healthy checks"
						value={form.consecutiveHealthyRequired}
						onChange={(value) => onChange((c) => ({ ...c, consecutiveHealthyRequired: value }))}
					/>
					<NoiseRow
						id="rule-renotify"
						label="Remind while open, every"
						unit="min"
						value={form.renotifyIntervalMinutes}
						onChange={(value) => onChange((c) => ({ ...c, renotifyIntervalMinutes: value }))}
					/>
					<SettingRow
						label="Alert when there is no data"
						description={
							grouped
								? "Not available on split rules: a quiet group keeps its incident open until data returns."
								: "Count an empty window as a breach. Off, those windows are skipped."
						}
						disabled={grouped}
						control={
							<Switch
								checked={form.alertOnNoData && !grouped}
								onCheckedChange={(checked) => onChange((c) => ({ ...c, alertOnNoData: checked }))}
							/>
						}
					/>
				</div>
			</div>
		</Card>
	)
}

function NoiseRow({
	id,
	label,
	unit,
	value,
	onChange,
}: {
	id: string
	label: string
	unit: string
	value: string
	onChange: (value: string) => void
}) {
	return (
		<Field className="items-stretch gap-1.5">
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<InputGroup className="h-9">
				<InputGroupInput
					id={id}
					type="number"
					inputMode="numeric"
					min={1}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					controlClassName="font-mono tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
				/>
				<InputGroupAddon align="inline-end">
					<InputGroupText>{unit}</InputGroupText>
				</InputGroupAddon>
			</InputGroup>
		</Field>
	)
}
