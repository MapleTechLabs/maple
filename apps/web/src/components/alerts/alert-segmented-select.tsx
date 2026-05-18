import type { ReactNode } from "react"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { cn } from "@maple/ui/utils"
import { CheckIcon } from "@/components/icons"

export type AlertSegmentedOption<T extends string> = {
	value: T
	label: ReactNode
	icon?: ReactNode
	disabled?: boolean
}

type Size = "sm" | "default"

export function AlertSegmentedSelect<T extends string>({
	options,
	value,
	onChange,
	size = "default",
	className,
	"aria-label": ariaLabel,
}: {
	options: ReadonlyArray<AlertSegmentedOption<T>>
	value: T
	onChange: (value: T) => void
	size?: Size
	className?: string
	"aria-label"?: string
}) {
	return (
		<ToggleGroup
			value={[value]}
			onValueChange={(values) => {
				const next = values[0] as T | undefined
				if (next && next !== value) onChange(next)
			}}
			variant="outline"
			size={size}
			aria-label={ariaLabel}
			className={cn("w-fit", className)}
		>
			{options.map((option) => (
				<ToggleGroupItem
					key={option.value}
					value={option.value}
					disabled={option.disabled}
					aria-label={typeof option.label === "string" ? option.label : option.value}
				>
					{option.icon}
					{option.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	)
}

export function AlertMultiSegmentedSelect<T extends string>({
	options,
	value,
	onChange,
	size = "default",
	className,
	"aria-label": ariaLabel,
}: {
	options: ReadonlyArray<AlertSegmentedOption<T>>
	value: readonly T[]
	onChange: (value: T[]) => void
	size?: Size
	className?: string
	"aria-label"?: string
}) {
	return (
		<ToggleGroup
			multiple
			connected={false}
			value={value}
			onValueChange={(next) => onChange(next as T[])}
			variant="outline"
			size={size}
			aria-label={ariaLabel}
			className={className}
		>
			{options.map((option) => {
				const selected = value.includes(option.value)
				return (
					<ToggleGroupItem
						key={option.value}
						value={option.value}
						disabled={option.disabled}
						aria-label={typeof option.label === "string" ? option.label : option.value}
						className={cn(
							"transition-colors",
							selected &&
								"border-primary/70 data-pressed:border-primary/70 data-pressed:bg-primary/10 data-pressed:text-foreground hover:bg-primary/15 dark:hover:bg-primary/15",
						)}
					>
						{(option.icon || selected) && (
							<span className="flex size-3.5 shrink-0 items-center justify-center">
								{selected ? (
									<CheckIcon className="size-3.5 text-primary opacity-100" />
								) : (
									option.icon
								)}
							</span>
						)}
						{option.label}
					</ToggleGroupItem>
				)
			})}
		</ToggleGroup>
	)
}
