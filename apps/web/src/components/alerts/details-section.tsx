import { useState, type Dispatch, type SetStateAction } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Textarea } from "@maple/ui/components/ui/textarea"

import { SectionLabel } from "@/components/alerts/signal-and-threshold-section"
import { PlusIcon } from "@/components/icons"
import type { RuleFormState } from "@/lib/alerts/form-utils"

interface DetailsSectionProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	suggestedName: string | null
}

/**
 * Display metadata for the rule — name (with a one-click suggestion derived
 * from signal + scope) and a free-text runbook field that stays collapsed
 * until the user opts in, because most rules ship without notes.
 */
export function DetailsSection({ form, onChange, suggestedName }: DetailsSectionProps) {
	const showSuggest =
		form.name.trim().length === 0 && suggestedName !== null && suggestedName.length > 0
	const hasExistingNotes = form.notes.trim().length > 0
	const [notesOpen, setNotesOpen] = useState(hasExistingNotes)

	return (
		<Card className="p-4">
			<SectionLabel>Details</SectionLabel>

			<div className="mt-3 space-y-3">
				<div className="space-y-1.5">
					<div className="flex items-center justify-between gap-2">
						<Label htmlFor="rule-name" className="text-xs">
							Rule name
						</Label>
						{showSuggest && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() =>
									onChange((c) => ({ ...c, name: suggestedName! }))
								}
								className="h-6 px-1.5 text-[11px]"
							>
								Suggest: {suggestedName}
							</Button>
						)}
					</div>
					<Input
						id="rule-name"
						value={form.name}
						onChange={(e) => onChange((c) => ({ ...c, name: e.target.value }))}
						placeholder="Error Rate — Payments"
					/>
				</div>

				{notesOpen ? (
					<div className="space-y-1.5">
						<Label htmlFor="rule-notes" className="text-xs">
							Notes
						</Label>
						<Textarea
							id="rule-notes"
							value={form.notes}
							onChange={(e) => onChange((c) => ({ ...c, notes: e.target.value }))}
							placeholder="Runbook links, ownership, or why this rule exists…"
							rows={2}
							autoFocus={!hasExistingNotes}
						/>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setNotesOpen(true)}
						className="flex w-full items-center gap-1.5 rounded-md border border-dashed border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground hover:border-border hover:text-foreground"
					>
						<PlusIcon size={12} />
						Add notes
					</button>
				)}
			</div>
		</Card>
	)
}
