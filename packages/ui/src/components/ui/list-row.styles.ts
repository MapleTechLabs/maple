import { cva } from "class-variance-authority"
import { cn } from "../../lib/utils"

// The 2px left lane a selectable row draws its selection in, reserved on every row and painted
// only on the selected one so contents never shift as selection moves (the sidebar's idiom).
export const ROW_LANE =
	"relative before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:transition-colors"

/** Lane + tint for a selected row, transparent lane otherwise. */
export function rowSelectedClass(selected: boolean | undefined): string {
	return cn(ROW_LANE, selected ? "bg-surface-strong before:bg-primary" : "before:bg-transparent")
}

export const listRowVariants = cva(
	"flex w-full min-w-0 items-center gap-3 text-left outline-none transition-colors hover:bg-surface-sunken focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
	{
		defaultVariants: { density: "default", divided: false },
		variants: {
			density: {
				compact: "px-3 py-1.5 text-xs",
				default: "px-4 py-2.5 text-sm",
			},
			divided: {
				false: "",
				true: "border-b border-border-subtle last:border-b-0",
			},
		},
	},
)

export const listRowLeadingStyles = "flex shrink-0 items-center text-muted-foreground"

export const listRowBodyStyles = "flex min-w-0 flex-1 flex-col gap-0.5"

export const listRowTitleStyles = "truncate font-medium text-foreground"

export const listRowMetaStyles = "truncate text-muted-foreground text-xs"

export const listRowTrailingStyles = "flex shrink-0 items-center gap-2"
