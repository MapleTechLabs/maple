import { cva } from "class-variance-authority"

export const buttonVariants = cva(
	"relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-base outline-none transition-[scale] duration-150 ease-out active:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-lg-inset pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-loading:select-none data-loading:text-transparent sm:text-sm [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
	{
		defaultVariants: {
			size: "default",
			variant: "default",
		},
		variants: {
			size: {
				default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8 [&_svg:not([class*='size-'])]:size-3.5",
				icon: "size-9 sm:size-8 [&_svg:not([class*='size-'])]:size-3.5",
				"icon-lg": "size-10 sm:size-9 [&_svg:not([class*='size-'])]:size-4",
				"icon-sm": "size-8 sm:size-7 [&_svg:not([class*='size-'])]:size-3.5",
				"icon-xl":
					"size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
				"icon-2xs": "size-4 rounded-sm before:rounded-sm-inset [&_svg:not([class*='size-'])]:size-3",
				"icon-xs":
					"size-7 rounded-md before:rounded-md-inset sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3",
				lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9 [&_svg:not([class*='size-'])]:size-4",
				sm: "h-8 gap-2 px-[calc(--spacing(2.5)-1px)] sm:h-7 [&_svg:not([class*='size-'])]:size-3.5",
				xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
				xs: "h-7 gap-1.5 rounded-md px-[calc(--spacing(2)-1px)] text-sm before:rounded-md-inset sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-3",
			},
			variant: {
				default:
					"not-disabled:inset-shadow-highlight border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-raised hover:bg-primary/90 active:bg-primary/90 data-pressed:bg-primary/90 *:data-[slot=button-loading-indicator]:text-primary-foreground disabled:not-data-loading:border-transparent disabled:not-data-loading:bg-input disabled:not-data-loading:text-muted-foreground [:active,[data-pressed]]:inset-shadow-pressed [:disabled,:active,[data-pressed]]:shadow-none",
				destructive:
					"not-disabled:inset-shadow-highlight border-destructive bg-destructive text-white shadow-destructive/24 shadow-raised hover:bg-destructive/90 active:bg-destructive/90 data-pressed:bg-destructive/90 dark:border-destructive/80 dark:bg-destructive/80 dark:hover:bg-destructive/72 dark:active:bg-destructive/72 dark:data-pressed:bg-destructive/72 *:data-[slot=button-loading-indicator]:text-white [:active,[data-pressed]]:inset-shadow-pressed [:disabled,:active,[data-pressed]]:shadow-none",
				"destructive-outline":
					"border-input bg-popover not-dark:bg-clip-padding text-destructive-foreground shadow-raised not-disabled:not-active:not-data-pressed:before:shadow-control hover:border-destructive-a3 active:border-destructive-a3 hover:bg-destructive-a1 active:bg-destructive-a1 data-pressed:border-destructive-a3 data-pressed:bg-destructive-a1 *:data-[slot=button-loading-indicator]:text-foreground dark:bg-input/32 [:disabled,:active,[data-pressed]]:shadow-none",
				// Add-a-row affordances ("Add threshold", "New dashboard"): an outline that reads as an empty slot.
				dashed: "active:scale-100! border-dashed border-input bg-transparent text-muted-foreground hover:bg-surface-sunken active:bg-surface-sunken hover:text-foreground active:text-foreground data-pressed:bg-surface-sunken *:data-[slot=button-loading-indicator]:text-foreground",
				ghost: "border-transparent text-foreground hover:bg-accent active:bg-accent data-pressed:bg-accent *:data-[slot=button-loading-indicator]:text-foreground",
				link: "border-transparent text-primary underline-offset-4 active:scale-100! hover:underline active:underline data-pressed:underline *:data-[slot=button-loading-indicator]:text-foreground",
				outline:
					"border-input bg-popover not-dark:bg-clip-padding text-foreground shadow-raised not-disabled:not-active:not-data-pressed:before:shadow-control hover:bg-surface-sunken active:bg-surface-sunken data-pressed:bg-accent/50 *:data-[slot=button-loading-indicator]:text-foreground dark:bg-input/32 dark:data-pressed:bg-input/64 dark:hover:bg-input/64 dark:active:bg-input/64 [:disabled,:active,[data-pressed]]:shadow-none",
				secondary:
					"border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/90 active:bg-secondary/90 data-pressed:bg-secondary/90 dark:bg-input/80 dark:hover:bg-input dark:active:bg-input dark:data-pressed:bg-input *:data-[slot=button-loading-indicator]:text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80",
			},
		},
	},
)

export const buttonLoadingIndicatorStyles = "pointer-events-none absolute"
