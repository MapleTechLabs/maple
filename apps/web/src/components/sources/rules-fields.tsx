import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@maple/ui/components/ui/input-group"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { AttributeRows } from "./attribute-rows"
import { EXPIRY_CHOICES, isExpiryChoice, MAX_RATE_LIMIT_RPS, type RulesDraft } from "./rules-draft"
import { rulesOutcome } from "./rules-payload"
import { SIGNALS } from "./shared"

/** Signals, rate limit, expiry and resource attributes for a push source. */
export function RulesFields({ draft, disabled = false }: { draft: RulesDraft; disabled?: boolean }) {
	const { rateLimitValid } = rulesOutcome(draft)
	const existing = draft.existing
	const expiryChoices = EXPIRY_CHOICES.filter(
		(choice) => choice.value !== "keep" || (existing !== null && existing.expires_at !== null),
	)
	return (
		<fieldset disabled={disabled} className="flex min-w-0 flex-col gap-6 disabled:opacity-60">
			<Field>
				<FieldLabel>Signals</FieldLabel>
				<div className="grid gap-2 sm:grid-cols-2">
					{SIGNALS.map((signal) => {
						const checked = draft.signals.includes(signal.value)
						return (
							<label
								key={signal.value}
								className={cn(
									"flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors",
									checked ? "border-primary/60 bg-primary/[0.06]" : "hover:bg-muted/30",
								)}
							>
								<Checkbox
									className="mt-0.5"
									checked={checked}
									disabled={disabled}
									onCheckedChange={(next) =>
										draft.setSignals((current) =>
											next
												? [...current, signal.value]
												: current.filter((value) => value !== signal.value),
										)
									}
								/>
								<span className="flex flex-col gap-0.5">
									<span className={cn("text-sm", !checked && "text-muted-foreground")}>
										{signal.label}
									</span>
									<span className="text-muted-foreground font-mono text-2xs">
										{signal.hint}
									</span>
								</span>
							</label>
						)
					})}
				</div>
				<FieldDescription>
					{draft.signals.length === 0
						? "Allow at least one signal."
						: "Anything else is rejected with a 403."}
				</FieldDescription>
			</Field>
			<Field>
				<FieldLabel htmlFor="source-rate-limit">Rate limit</FieldLabel>
				<InputGroup className="w-44">
					<InputGroupInput
						id="source-rate-limit"
						inputMode="numeric"
						placeholder="No limit"
						value={draft.rateLimitText}
						disabled={disabled}
						onChange={(event) => draft.setRateLimitText(event.target.value)}
						controlClassName="font-mono tabular-nums"
					/>
					<InputGroupAddon align="inline-end">
						<InputGroupText>req/s</InputGroupText>
					</InputGroupAddon>
				</InputGroup>
				<FieldDescription>
					{rateLimitValid
						? "Leave empty for no limit. Requests over the limit get a 429."
						: `Enter a whole number between 1 and ${MAX_RATE_LIMIT_RPS}, or leave it empty.`}
				</FieldDescription>
			</Field>
			<Field>
				<FieldLabel>Expires</FieldLabel>
				<ToggleGroup
					variant="outline"
					size="sm"
					aria-label="Expires"
					value={[draft.expiry]}
					disabled={disabled}
					onValueChange={(values) => {
						const next = values.find((value) => value !== draft.expiry)
						if (next !== undefined && isExpiryChoice(next)) draft.setExpiry(next)
					}}
				>
					{expiryChoices.map((choice) => (
						<ToggleGroupItem key={choice.value} value={choice.value}>
							{choice.label}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				{existing !== null && existing.expires_at !== null && draft.expiry === "keep" && (
					<FieldDescription>
						{existing.status === "expired" ? "Expired" : "Expires"}{" "}
						{formatRelativeTime(existing.expires_at)}.
					</FieldDescription>
				)}
			</Field>
			<Field>
				<FieldLabel>Resource attributes</FieldLabel>
				<FieldDescription>Written on everything this source sends.</FieldDescription>
				<AttributeRows draft={draft} disabled={disabled} />
			</Field>
		</fieldset>
	)
}
