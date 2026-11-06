import { cva } from "class-variance-authority"

export const itemVariants = cva(
	"[a]:hover:bg-muted [a]:active:bg-muted rounded-xl border text-xs w-full group/item focus-visible:border-ring focus-visible:ring-ring/50 flex items-center flex-wrap outline-none duration-100 focus-visible:ring-[3px] [a]:transition-colors",
	{
		variants: {
			variant: {
				default: "border-transparent",
				outline: "border-border",
				muted: "bg-surface-sunken border-transparent",
				// Raised panel row on the page surface (integration headers, linked resources).
				card: "rounded-lg border-border-subtle bg-card",
				// Row inside a `divide-y` list: no frame of its own.
				flush: "rounded-none border-transparent",
			},
			size: {
				default: "gap-2.5 px-3 py-2.5",
				sm: "gap-2.5 px-3 py-2.5",
				xs: "gap-2 px-2.5 py-2 [[data-slot=dropdown-menu-content]_&]:p-0",
				// Page-level rows at body text size.
				lg: "gap-3 px-4 py-3 text-sm",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
)

export const itemMediaVariants = cva(
	"gap-2 group-has-[[data-slot=item-description]]/item:translate-y-0.5 group-has-[[data-slot=item-description]]/item:self-start flex shrink-0 items-center justify-center [&_svg]:pointer-events-none",
	{
		variants: {
			variant: {
				default: "bg-transparent",
				icon: "[&_svg:not([class*='size-'])]:size-4",
				image: "size-10 overflow-hidden rounded-lg group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-6 [&_img]:size-full [&_img]:object-cover",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
)

export const itemGroupStyles =
	"gap-4 has-[[data-size=sm]]:gap-2.5 has-[[data-size=xs]]:gap-2 group/item-group flex w-full flex-col"

export const itemSeparatorStyles = "my-2"

export const itemContentStyles =
	"gap-1 group-data-[size=xs]/item:gap-0 group-data-[size=lg]/item:gap-0.5 flex min-w-0 flex-[1_1_12rem] flex-col [&+[data-slot=item-content]]:flex-none"

export const itemTitleStyles =
	"gap-2 text-xs group-data-[size=lg]/item:text-sm font-medium underline-offset-4 line-clamp-1 flex w-fit max-w-full items-center"

export const itemDescriptionStyles =
	"text-muted-foreground text-left text-xs/relaxed group-data-[size=xs]/item:text-xs/relaxed [&>a:hover]:text-primary line-clamp-2 font-normal [&>a]:underline [&>a]:underline-offset-4"

export const itemActionsStyles = "gap-2 flex items-center"

export const itemHeaderStyles = "gap-2 flex basis-full items-center justify-between"
export const itemFooterStyles = "gap-2 flex basis-full items-center justify-between"
