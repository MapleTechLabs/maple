import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"

/** Base UI selects need a real value for "no filter"; this is it, and it never reaches the URL. */
const ALL = "__all__"

export interface FacetSelectOption {
	readonly name: string
}

interface FacetSelectProps {
	/** The dimension, drawn small beside the value: `service All`. */
	label: string
	value: string | undefined
	options: ReadonlyArray<FacetSelectOption>
	onChange: (value: string | undefined) => void
	className?: string
}

/**
 * A label-prefixed single-value filter select with an "All" option. A set value is drawn in
 * the primary tint so a toolbar reads as "what is narrowing this page" at a glance.
 */
export function FacetSelect({ label, value, options, onChange, className }: FacetSelectProps) {
	const set = value !== undefined
	return (
		<Select
			value={value ?? ALL}
			onValueChange={(next) => onChange(next === ALL || next === null ? undefined : next)}
			// A dimension the window reported nothing for cannot be chosen from,
			// and a select that opens onto one row reads as broken.
			disabled={options.length === 0}
		>
			<SelectTrigger
				size="sm"
				aria-label={label}
				className={cn(
					"h-[30px] gap-2 rounded-md px-2.5 font-mono text-xs",
					set
						? "border-primary/40 bg-primary/10 text-primary [&_svg]:text-primary"
						: "bg-card text-foreground",
					className,
				)}
			>
				{/* The sentinel is a Base UI implementation detail; rendered children
				    are what keeps it off the trigger. */}
				<SelectValue>
					<span className={cn("text-2xs", set ? "text-primary/70" : "text-muted-foreground")}>
						{label}
					</span>{" "}
					{value ?? "All"}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>All</SelectItem>
				{options.map((option) => (
					<SelectItem key={option.name} value={option.name}>
						{option.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}
