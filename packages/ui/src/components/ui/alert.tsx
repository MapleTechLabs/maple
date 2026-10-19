import type { VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "../../lib/utils"
import { alertActionStyles, alertDescriptionStyles, alertTitleStyles, alertVariants } from "./alert.styles"

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
	return <div className={cn(alertTitleStyles, className)} data-slot="alert-title" {...props} />
}

export function AlertDescription({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(alertDescriptionStyles, className)} data-slot="alert-description" {...props} />
}

export function AlertAction({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(alertActionStyles, className)} data-slot="alert-action" {...props} />
}
