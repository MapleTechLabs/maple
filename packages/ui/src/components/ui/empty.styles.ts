import { cva } from "class-variance-authority"

export const emptyMediaVariants = cva(
	"flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		defaultVariants: {
			variant: "default",
		},
		variants: {
			variant: {
				default: "bg-transparent",
				icon: "relative flex size-9 shrink-0 items-center justify-center rounded-md border bg-card not-dark:bg-clip-padding text-foreground shadow-raised before:pointer-events-none before:absolute before:inset-0 before:rounded-md-inset before:shadow-control [&_svg:not([class*='size-'])]:size-4.5",
			},
		},
	},
)

export const emptyStyles =
	"flex min-w-0 flex-1 flex-col items-center justify-center gap-6 text-balance px-6 py-12 text-center md:py-20"

export const emptyHeaderStyles = "flex max-w-sm flex-col items-center text-center"

export const emptyMediaStyles = "relative mb-6"

export const emptyMediaStackLeftStyles =
	"pointer-events-none absolute bottom-px origin-bottom-left -translate-x-0.5 -rotate-10 scale-84 shadow-none"

export const emptyMediaStackRightStyles =
	"pointer-events-none absolute bottom-px origin-bottom-right translate-x-0.5 rotate-10 scale-84 shadow-none"

export const emptyTitleStyles = "font-heading font-semibold text-xl"

export const emptyDescriptionStyles =
	"text-muted-foreground text-sm [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4 [[data-slot=empty-title]+&]:mt-1"

export const emptyContentStyles =
	"flex w-full min-w-0 max-w-sm flex-col items-center gap-4 text-balance text-sm"

export const emptyMessageStyles = "px-4 py-8 text-center text-muted-foreground text-xs"

export const emptyMessageDashedStyles = "rounded-md border border-dashed text-sm"
