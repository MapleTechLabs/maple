import type React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"
import {
	bubbleContentStyles,
	bubbleGroupStyles,
	bubbleReactionsVariants,
	bubbleVariants,
} from "./bubble.styles"

function BubbleGroup({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="bubble-group" className={cn(bubbleGroupStyles, className)} {...props} />
}

function Bubble({
	variant = "default",
	align = "start",
	className,
	...props
}: React.ComponentProps<"div"> &
	VariantProps<typeof bubbleVariants> & {
		align?: "start" | "end"
	}) {
	return (
		<div
			data-slot="bubble"
			data-variant={variant}
			data-align={align}
			className={cn(bubbleVariants({ variant }), className)}
			{...props}
		/>
	)
}

function BubbleContent({ className, render, ...props }: useRender.ComponentProps<"div">) {
	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(
			{
				className: cn(bubbleContentStyles, className),
			},
			props,
		),
		render,
		state: {
			slot: "bubble-content",
		},
	})
}

function BubbleReactions({
	side = "bottom",
	align = "end",
	className,
	...props
}: React.ComponentProps<"div"> & {
	align?: "start" | "end"
	side?: "top" | "bottom"
}) {
	return (
		<div
			data-slot="bubble-reactions"
			data-align={align}
			data-side={side}
			className={cn(bubbleReactionsVariants({ side, align }), className)}
			{...props}
		/>
	)
}

export { BubbleGroup, Bubble, BubbleContent, BubbleReactions }
