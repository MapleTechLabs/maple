import { useState, type Dispatch, type SetStateAction } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import { Textarea } from "@maple/ui/components/ui/textarea"

import { SectionHeader } from "@/components/layout/section-header"
import { TagInput } from "@/components/alerts/tag-input"
import { PlusIcon } from "@/components/icons"
import type { RuleFormState } from "@/lib/alerts/form-utils"

interface DetailsSectionProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	suggestedName: string | null
	/** Tags already used across the org's rules, offered as autocomplete. */
	tagSuggestions?: string[]
}

/**
 * Display metadata for the rule — name (with a one-click suggestion derived
 * from signal + scope) and a free-text runbook field that stays collapsed
 * until the user opts in, because most rules ship without notes.
 */
export function DetailsSection({ form, onChange, suggestedName, tagSuggestions }: DetailsSectionProps) {
	const showSuggest = form.name.trim().length === 0 && suggestedName !== null && suggestedName.length > 0
	const hasExistingNotes = form.notes.trim().length > 0
	const [notesOpen, setNotesOpen] = useState(hasExistingNotes)

	return (
		<Card className="p-4">
			<SectionHeader id="rule-details-heading" label="Details" />

			<div className="space-y-3">
				<Field className="items-stretch gap-1.5">
					<div className="flex items-center justify-between gap-2">
						<FieldLabel htmlFor="rule-name">Rule name</FieldLabel>
						{showSuggest && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => onChange((c) => ({ ...c, name: suggestedName! }))}
								className="h-6 px-1.5 text-2xs"
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
				</Field>

				<Field className="items-stretch gap-1.5">
					<FieldLabel htmlFor="rule-tags">Tags</FieldLabel>
					<TagInput
						id="rule-tags"
						value={form.tags}
						onChange={(tags) => onChange((c) => ({ ...c, tags }))}
						suggestions={tagSuggestions}
						placeholder="prod, payments, team-checkout…"
					/>
					<FieldDescription>
						Group and filter rules in the alerts list. Press Enter to add.
					</FieldDescription>
				</Field>

				{notesOpen ? (
					<Field className="items-stretch gap-1.5">
						<FieldLabel htmlFor="rule-notes">Notes</FieldLabel>
						<Textarea
							id="rule-notes"
							value={form.notes}
							onChange={(e) => onChange((c) => ({ ...c, notes: e.target.value }))}
							placeholder="Runbook links, ownership, or why this rule exists…"
							rows={2}
							autoFocus={!hasExistingNotes}
						/>
					</Field>
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
