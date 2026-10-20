"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type React from "react"
import { cn } from "../../lib/utils"
import {
	cardActionStyles,
	cardDescriptionStyles,
	cardFooterStyles,
	cardHeaderStyles,
	cardPanelStyles,
	cardStyles,
	cardTitleStyles,
} from "./card.styles"

export function Card({ className, render, ...props }: useRender.ComponentProps<"div">): React.ReactElement {
	const defaultProps = {
		className: cn(cardStyles, className),
		"data-slot": "card",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(defaultProps, props),
		render,
	})
}

export function CardHeader({
	className,
	render,
	...props
}: useRender.ComponentProps<"div">): React.ReactElement {
	const defaultProps = {
		className: cn(cardHeaderStyles, className),
		"data-slot": "card-header",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(defaultProps, props),
		render,
	})
}

export function CardTitle({
	className,
	render,
	...props
}: useRender.ComponentProps<"div">): React.ReactElement {
	const defaultProps = {
		className: cn(cardTitleStyles, className),
		"data-slot": "card-title",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(defaultProps, props),
		render,
	})
}

export function CardDescription({
	className,
	render,
	...props
}: useRender.ComponentProps<"div">): React.ReactElement {
	const defaultProps = {
		className: cn(cardDescriptionStyles, className),
		"data-slot": "card-description",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(defaultProps, props),
		render,
	})
}

export function CardAction({
	className,
	render,
	...props
}: useRender.ComponentProps<"div">): React.ReactElement {
	const defaultProps = {
		className: cn(cardActionStyles, className),
		"data-slot": "card-action",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(defaultProps, props),
		render,
	})
}

export function CardPanel({
	className,
	render,
	...props
}: useRender.ComponentProps<"div">): React.ReactElement {
	const defaultProps = {
		className: cn(cardPanelStyles, className),
		"data-slot": "card-panel",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(defaultProps, props),
		render,
	})
}

export function CardFooter({
	className,
	render,
	...props
}: useRender.ComponentProps<"div">): React.ReactElement {
	const defaultProps = {
		className: cn(cardFooterStyles, className),
		"data-slot": "card-footer",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(defaultProps, props),
		render,
	})
}

export { CardPanel as CardContent }
