import { cva } from "class-variance-authority"

export const alertVariants = cva(
	"relative grid w-full items-start gap-x-2 gap-y-0.5 rounded-xl border px-3.5 py-3 text-card-foreground text-sm has-[>svg]:has-data-[slot=alert-action]:grid-cols-[calc(var(--spacing)*4)_1fr_auto] has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-data-[slot=alert-action]:grid-cols-[1fr_auto] has-[>svg]:gap-x-2 [&>svg]:h-lh [&>svg]:w-4",
	{
		defaultVariants: {
			size: "default",
			variant: "default",
		},
		variants: {
			size: {
				default: "",
				// Inline callout inside a form, panel or chat turn.
				sm: "rounded-lg px-2.5 py-1.5 text-xs [&>svg]:w-3.5",
			},
			variant: {
				default: "bg-transparent dark:bg-input/32 [&>svg]:text-muted-foreground",
				crit: "border-severity-error-a3 bg-severity-error-a1 [&>svg]:text-severity-error",
				info: "border-severity-info-a3 bg-severity-info-a1 [&>svg]:text-severity-info",
				done: "border-severity-debug-a3 bg-severity-debug-a1 [&>svg]:text-severity-debug",
				ok: "border-severity-info-a3 bg-severity-info-a1 [&>svg]:text-severity-info",
				warn: "border-severity-warn-a3 bg-severity-warn-a1 [&>svg]:text-severity-warn",
			},
		},
	},
)

export const alertTitleStyles = "font-medium [svg~&]:col-start-2"

export const alertDescriptionStyles = "flex flex-col gap-2.5 text-muted-foreground [svg~&]:col-start-2"

export const alertActionStyles =
	"flex gap-1 max-sm:col-start-2 max-sm:mt-2 sm:row-start-1 sm:row-end-3 sm:self-center sm:[[data-slot=alert-description]~&]:col-start-2 sm:[[data-slot=alert-title]~&]:col-start-2 sm:[svg~&]:col-start-2 sm:[svg~[data-slot=alert-description]~&]:col-start-3 sm:[svg~[data-slot=alert-title]~&]:col-start-3"
