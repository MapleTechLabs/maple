import type React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"
import { markerContentStyles, markerIconStyles, markerVariants } from "./marker.styles"

function Marker({
	className,
	variant = "default",
	render,
	...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof markerVariants>) {
	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(
			{
				className: cn(markerVariants({ variant, className })),
			},
			props,
		),
		render,
		state: {
			slot: "marker",
			variant,
		},
	})
}

function MarkerIcon({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="marker-icon"
			aria-hidden="true"
			className={cn(markerIconStyles, className)}
			{...props}
		/>
	)
}

function MarkerContent({ className, ...props }: React.ComponentProps<"span">) {
	return <span data-slot="marker-content" className={cn(markerContentStyles, className)} {...props} />
}

export { Marker, MarkerIcon, MarkerContent, markerVariants }
