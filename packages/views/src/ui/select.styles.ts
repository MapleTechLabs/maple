import { cva } from "class-variance-authority"

export const selectTriggerVariants = cva(
	"relative inline-flex min-h-9 min-w-36 select-none items-center justify-between gap-2 rounded-lg border border-input bg-background not-dark:bg-clip-padding px-[calc(--spacing(3)-1px)] text-left text-base text-foreground shadow-raised outline-none ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-lg-inset not-data-disabled:not-focus-visible:not-aria-invalid:not-data-pressed:before:shadow-control pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 focus-visible:border-ring focus-visible:ring-[3px] aria-invalid:border-destructive-a4 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive-a2 data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-8 sm:text-sm dark:bg-input/32 dark:aria-invalid:ring-destructive-a3 [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [[data-disabled],:focus-visible,[aria-invalid],[data-pressed]]:shadow-none",
	{
		defaultVariants: {
			size: "default",
		},
		variants: {
			size: {
				default: "",
				lg: "min-h-10 sm:min-h-9",
				sm: "min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:min-h-7",
			},
		},
	},
)

export const selectTriggerIconClassName = "-me-1 size-4 opacity-80 sm:size-3.5"

export const selectButtonValueStyles = "flex-1 truncate in-data-placeholder:text-foreground-subtle"

export const selectButtonStyles = "min-w-0"

export const selectValueStyles = "flex-1 truncate data-placeholder:text-muted-foreground"

export const selectPositionerStyles = "z-50 select-none"

export const selectPopupStyles = "origin-(--transform-origin) text-foreground outline-none"

export const selectScrollUpArrowStyles =
	"top-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:top-px before:h-[200%] before:rounded-t-lg-inset before:bg-linear-to-b before:from-50% before:from-popover"

export const selectScrollUpArrowIconStyles = "relative size-4.5 sm:size-4"

export const selectScrollDownArrowIconStyles = "relative size-4.5 sm:size-4"

export const selectPopupSurfaceStyles =
	"relative h-full min-w-(--anchor-width) rounded-lg border bg-popover not-dark:bg-clip-padding shadow-popup before:pointer-events-none before:absolute before:inset-0 before:rounded-lg-inset before:shadow-control"

export const selectListStyles = "max-h-(--available-height) overflow-y-auto p-1"

export const selectScrollDownArrowStyles =
	"bottom-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:bottom-px before:h-[200%] before:rounded-b-lg-inset before:bg-linear-to-t before:from-50% before:from-popover"

export const selectItemStyles =
	"grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const selectItemIndicatorStyles = "col-start-1"

export const selectItemIndicatorIconStyles = "size-4 sm:size-3.5"

export const selectItemTextStyles = "col-start-2 min-w-0"

export const selectSeparatorStyles = "mx-2 my-1 h-px bg-border"

export const selectLabelStyles =
	"not-in-data-[slot=field]:mb-2 inline-flex cursor-default items-center gap-2 font-medium text-base/4.5 text-foreground sm:text-sm/4"

export const selectGroupLabelStyles = "px-2 py-1.5 font-medium text-muted-foreground text-xs"
