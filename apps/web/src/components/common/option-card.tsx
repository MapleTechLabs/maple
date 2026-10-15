import type { ReactNode } from "react"
import { cn } from "@maple/ui/lib/utils"

import { DrawnCheck } from "@/components/common/drawn-check"

interface OptionCardProps {
	type: "radio" | "checkbox"
	/** Groups radios; checkboxes can omit it. */
	name?: string
	checked: boolean
	onChange: () => void
	disabled?: boolean
	/** Accessible name of the hidden input. */
	label: string
	title: ReactNode
	description?: ReactNode
	/** Leading visual: a glyph in `row`, a larger image in `stacked`. */
	media?: ReactNode
	/** Content pinned to the bottom of a `stacked` card. */
	footer?: ReactNode
	/** `row`: media, text, check side by side. `stacked`: media and check above the text. */
	layout?: "row" | "stacked"
	/** Hex colour that replaces primary for the selected border and tint. */
	accent?: string
	/** Classes for the selected check, paired with `accent`. */
	checkClassName?: string
}

/**
 * A large selectable card backed by a visually hidden radio or checkbox. Radios hide the check
 * until selected; checkboxes always show it so the multi-select affordance reads.
 */
export function OptionCard({
	type,
	name,
	checked,
	onChange,
	disabled,
	label,
	title,
	description,
	media,
	footer,
	layout = "row",
	accent,
	checkClassName,
}: OptionCardProps) {
	const check = (
		<DrawnCheck
			checked={checked}
			className={cn(
				layout === "row" && "mt-0.5",
				checked ? checkClassName : type === "radio" && "opacity-0",
			)}
		/>
	)
	return (
		<label className="group relative cursor-pointer">
			<input
				type={type}
				name={name}
				className="peer sr-only"
				checked={checked}
				disabled={disabled}
				aria-label={label}
				onChange={onChange}
			/>
			<div
				style={
					checked && accent !== undefined
						? { borderColor: accent, backgroundColor: `${accent}0F` }
						: undefined
				}
				className={cn(
					"flex h-full rounded-md border transition-colors duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
					layout === "row" ? "items-start gap-3 p-4" : "flex-col gap-5 p-5",
					!checked
						? "border-border group-hover:border-foreground/30 group-hover:bg-foreground/[0.02]"
						: accent === undefined && "border-primary bg-primary/5",
				)}
			>
				{layout === "row" ? (
					<>
						{media}
						<div className="min-w-0 flex-1 pt-px">
							<span className="block text-sm font-semibold">{title}</span>
							{description ? (
								<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
									{description}
								</span>
							) : null}
						</div>
						{check}
					</>
				) : (
					<>
						<div className="flex items-start justify-between">
							{media}
							{check}
						</div>
						<div className="space-y-1">
							<span className="block text-base font-semibold tracking-tight">{title}</span>
							{description ? (
								<span className="block text-sm text-muted-foreground">{description}</span>
							) : null}
						</div>
						{footer ? <div className="mt-auto flex">{footer}</div> : null}
					</>
				)}
			</div>
		</label>
	)
}
