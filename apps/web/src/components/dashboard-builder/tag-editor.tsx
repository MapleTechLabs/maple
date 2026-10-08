import { useState } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { FormDialog } from "@maple/ui/components/ui/form-dialog"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { Input } from "@maple/ui/components/ui/input"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"

import { PlusIcon, XmarkIcon } from "@/components/icons"

/** Longest tag we store. Long enough for `checkout-service-slo`, short enough that
 *  the list's Tags menu and the filter chips never wrap. */
const MAX_TAG_LENGTH = 32

/**
 * The single normalisation both call sites share, so the list's Tags menu never
 * shows near-duplicates (`API` next to `api `). Case-folding is the important
 * part: `matchesTags` compares tags exactly, so an unfolded `API` would be
 * unreachable from a filter chip that says `api`.
 */
export function normalizeTags(input: ReadonlyArray<string>): string[] {
	const seen = new Set<string>()
	for (const raw of input) {
		const tag = raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH)
		if (tag !== "") seen.add(tag)
	}
	return Array.from(seen).sort()
}

/** Splits pasted or typed input on the separators users actually reach for. */
const splitInput = (value: string): string[] => value.split(/[,\n]/)

export function TagEditorDialog({
	open,
	onOpenChange,
	dashboardName,
	tags,
	suggestions = [],
	onSave,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	dashboardName: string
	tags: ReadonlyArray<string>
	/** Tags already in use across the org, offered as one-click adds. */
	suggestions?: ReadonlyArray<string>
	onSave: (tags: string[]) => void
}) {
	const [drafts, setDrafts] = useState<string[]>(() => normalizeTags(tags))
	const [pending, setPending] = useState("")
	// Each opening starts from the saved tags, matching `VariablesManagerDialog`.
	const [wasOpen, setWasOpen] = useState(open)
	if (open !== wasOpen) {
		setWasOpen(open)
		if (open) {
			setDrafts(normalizeTags(tags))
			setPending("")
		}
	}

	const commit = (value: string) => {
		const added = normalizeTags(splitInput(value))
		if (added.length === 0) return
		setDrafts((prev) => normalizeTags([...prev, ...added]))
		setPending("")
	}

	const remove = (tag: string) => setDrafts((prev) => prev.filter((t) => t !== tag))

	// Only tags this dashboard doesn't already carry are worth a click.
	const unused = normalizeTags(suggestions).filter((tag) => !drafts.includes(tag))

	return (
		<FormDialog
			open={open}
			onOpenChange={onOpenChange}
			className="sm:max-w-md"
			panelClassName="flex flex-col gap-3 space-y-0"
			title="Tags"
			description={
				<>
					Group <span className="text-foreground">{dashboardName}</span> with related dashboards.
					Tags drive the Tags filter on the dashboards list.
				</>
			}
			submitLabel="Save"
			// Commits `pending` first: onBlur fires before click on most browsers
			// but not all, and losing a just-typed tag on Save is unforgiving.
			onSubmit={() => {
				onSave(normalizeTags([...drafts, ...splitInput(pending)]))
				onOpenChange(false)
			}}
		>
			<Field className="items-stretch gap-1.5">
				<FieldLabel className="text-xs" htmlFor="tag-editor-input">
					Add a tag
				</FieldLabel>
				<div className="flex items-center gap-1.5">
					<Input
						id="tag-editor-input"
						size="sm"
						value={pending}
						placeholder="slo, api, team-platform"
						maxLength={MAX_TAG_LENGTH}
						onChange={(event) => setPending(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === ",") {
								// Enter must not reach the dialog's default submit — the
								// pending tag isn't saved yet.
								event.preventDefault()
								commit(pending)
								return
							}
							// Backspace on an empty field pops the last chip, the
							// convention every tag input shares.
							if (event.key === "Backspace" && pending === "" && drafts.length > 0) {
								event.preventDefault()
								remove(drafts[drafts.length - 1]!)
							}
						}}
						// Committing on blur means a typed tag is never silently lost by
						// clicking Save directly.
						onBlur={() => commit(pending)}
					/>
					<IconButton
						variant="outline"
						label="Add tag"
						disabled={normalizeTags(splitInput(pending)).length === 0}
						onClick={() => commit(pending)}
					>
						<PlusIcon size={14} />
					</IconButton>
				</div>
			</Field>

			<Field className="items-stretch gap-1.5">
				<FieldLabel className="text-xs">On this dashboard</FieldLabel>
				{drafts.length === 0 ? (
					<FieldDescription className="text-2xs">
						No tags yet, so this dashboard won't appear under any Tags filter.
					</FieldDescription>
				) : (
					<div className="flex flex-wrap gap-1">
						{drafts.map((tag) => (
							<Badge key={tag} variant="secondary" className="gap-1 pr-1 font-mono text-2xs">
								{tag}
								<IconButton
									size="icon-xs"
									label={`Remove tag ${tag}`}
									tooltip={false}
									className="size-4 text-muted-foreground hover:text-foreground"
									onClick={() => remove(tag)}
								>
									<XmarkIcon size={11} />
								</IconButton>
							</Badge>
						))}
					</div>
				)}
			</Field>

			{unused.length > 0 && (
				<Field className="items-stretch gap-1.5">
					<FieldLabel className="text-xs">Used elsewhere</FieldLabel>
					<div className="flex flex-wrap gap-1">
						{unused.map((tag) => (
							<Button
								key={tag}
								variant="outline"
								size="xs"
								className="font-mono text-2xs"
								onClick={() => commit(tag)}
							>
								<PlusIcon size={10} data-icon="inline-start" />
								{tag}
							</Button>
						))}
					</div>
				</Field>
			)}
		</FormDialog>
	)
}
