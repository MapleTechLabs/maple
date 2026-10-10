import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "../../lib/utils"

const alertVariants = cva(
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
				crit: "border-severity-error/32 bg-severity-error/4 [&>svg]:text-severity-error",
				info: "border-severity-info/32 bg-severity-info/4 [&>svg]:text-severity-info",
				done: "border-severity-debug/32 bg-severity-debug/4 [&>svg]:text-severity-debug",
				ok: "border-severity-info/32 bg-severity-info/4 [&>svg]:text-severity-info",
				warn: "border-severity-warn/32 bg-severity-warn/4 [&>svg]:text-severity-warn",
			},
		},
	},
)

export function Alert({
	className,
	variant,
	size,
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>): React.ReactElement {
	return (
		<div
			className={cn(alertVariants({ size, variant }), className)}
			data-slot="alert"
			role="alert"
			{...props}
		/>
	)
}

export function AlertTitle({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn("font-medium [svg~&]:col-start-2", className)}
			data-slot="alert-title"
			{...props}
		/>
	)
}

export function AlertDescription({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn("flex flex-col gap-2.5 text-muted-foreground [svg~&]:col-start-2", className)}
			data-slot="alert-description"
			{...props}
		/>
	)
}

export function AlertAction({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn(
				"flex gap-1 max-sm:col-start-2 max-sm:mt-2 sm:row-start-1 sm:row-end-3 sm:self-center sm:[[data-slot=alert-description]~&]:col-start-2 sm:[[data-slot=alert-title]~&]:col-start-2 sm:[svg~&]:col-start-2 sm:[svg~[data-slot=alert-description]~&]:col-start-3 sm:[svg~[data-slot=alert-title]~&]:col-start-3",
				className,
			)}
			data-slot="alert-action"
			{...props}
		/>
	)
}
