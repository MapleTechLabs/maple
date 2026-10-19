import { Button } from "@maple/ui/components/ui/button"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { Input } from "@maple/ui/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { PlusIcon, XmarkIcon } from "@/components/icons"
import { MAX_ATTRIBUTES, newAttributeDraft, type RulesDraft } from "./rules-draft"
import { rulesOutcome } from "./rules-payload"
import { MODE_LABELS } from "./shared"

/** Editable key, value and mode rows, with the first validation problem inline. */
export function AttributeRows({ draft, disabled }: { draft: RulesDraft; disabled: boolean }) {
	const { attributeProblem } = rulesOutcome(draft)
	return (
		<div className="flex flex-col gap-2">
			{draft.attributes.map((attribute) => (
				<div key={attribute.rowId} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
					<Input
						aria-label="Attribute key"
						placeholder="service.name"
						className="w-full min-w-0 font-mono text-xs sm:w-auto sm:flex-1"
						value={attribute.key}
						onChange={(event) =>
							draft.updateAttribute(attribute.rowId, { key: event.target.value })
						}
					/>
					<Input
						aria-label="Attribute value"
						placeholder="value"
						className="w-full min-w-0 font-mono text-xs sm:w-auto sm:flex-1"
						value={attribute.value}
						onChange={(event) =>
							draft.updateAttribute(attribute.rowId, { value: event.target.value })
						}
					/>
					<ToggleGroup
						variant="outline"
						size="sm"
						aria-label={`When to write ${attribute.key || "this attribute"}`}
						className="w-44 shrink-0"
						value={[attribute.mode]}
						onValueChange={(values) => {
							const next = values.find((value) => value !== attribute.mode)
							if (next === "set" || next === "default")
								draft.updateAttribute(attribute.rowId, { mode: next })
						}}
					>
						<ToggleGroupItem value="set" className="flex-1">
							{MODE_LABELS.set}
						</ToggleGroupItem>
						<ToggleGroupItem value="default" className="flex-1">
							{MODE_LABELS.default}
						</ToggleGroupItem>
					</ToggleGroup>
					<IconButton
						className="text-muted-foreground hover:text-foreground shrink-0"
						label="Remove attribute"
						onClick={() =>
							draft.setAttributes((rows) => rows.filter((row) => row.rowId !== attribute.rowId))
						}
					>
						<XmarkIcon />
					</IconButton>
				</div>
			))}
			<div className="flex items-center gap-3">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="text-primary -ml-2"
					disabled={disabled || draft.attributes.length >= MAX_ATTRIBUTES}
					onClick={() => draft.setAttributes((rows) => [...rows, newAttributeDraft()])}
				>
					<PlusIcon data-icon="inline-start" />
					Add attribute
				</Button>
				{attributeProblem !== null && (
					<span className="text-destructive text-xs" role="alert">
						{attributeProblem}
					</span>
				)}
			</div>
		</div>
	)
}
