import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"
import { Separator } from "./separator"
import {
	itemActionsStyles,
	itemContentStyles,
	itemDescriptionStyles,
	itemFooterStyles,
	itemGroupStyles,
	itemHeaderStyles,
	itemMediaVariants,
	itemSeparatorStyles,
	itemTitleStyles,
	itemVariants,
} from "./item.styles"

function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
	return <div role="list" data-slot="item-group" className={cn(itemGroupStyles, className)} {...props} />
}

function ItemSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
	return (
		<Separator
			data-slot="item-separator"
			orientation="horizontal"
			className={cn(itemSeparatorStyles, className)}
			{...props}
		/>
	)
}

function Item({
	className,
	variant = "default",
	size = "default",
	render,
	...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(
			{
				className: cn(itemVariants({ variant, size, className })),
			},
			props,
		),
		render,
		state: {
			slot: "item",
			variant,
			size,
		},
	})
}

function ItemMedia({
	className,
	variant = "default",
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemMediaVariants>) {
	return (
		<div
			data-slot="item-media"
			data-variant={variant}
			className={cn(itemMediaVariants({ variant, className }))}
			{...props}
		/>
	)
}

function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="item-content" className={cn(itemContentStyles, className)} {...props} />
}

function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="item-title" className={cn(itemTitleStyles, className)} {...props} />
}

function ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
	return <p data-slot="item-description" className={cn(itemDescriptionStyles, className)} {...props} />
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="item-actions" className={cn(itemActionsStyles, className)} {...props} />
}

function ItemHeader({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="item-header" className={cn(itemHeaderStyles, className)} {...props} />
}

function ItemFooter({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="item-footer" className={cn(itemFooterStyles, className)} {...props} />
}

export {
	Item,
	ItemMedia,
	ItemContent,
	ItemActions,
	ItemGroup,
	ItemSeparator,
	ItemTitle,
	ItemDescription,
	ItemHeader,
	ItemFooter,
}
