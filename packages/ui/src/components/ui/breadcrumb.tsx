"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { ChevronRightIcon, DotsIcon } from "../icons"
import type * as React from "react"
import { cn } from "../../lib/utils"
import {
	breadcrumbEllipsisIconStyles,
	breadcrumbEllipsisLabelStyles,
	breadcrumbItemStyles,
	breadcrumbLinkStyles,
	breadcrumbListStyles,
	breadcrumbPageStyles,
	breadcrumbSeparatorStyles,
} from "./breadcrumb.styles"

export function Breadcrumb({ ...props }: React.ComponentProps<"nav">): React.ReactElement {
	return <nav aria-label="breadcrumb" data-slot="breadcrumb" {...props} />
}

export function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">): React.ReactElement {
	return <ol className={cn(breadcrumbListStyles, className)} data-slot="breadcrumb-list" {...props} />
}

export function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">): React.ReactElement {
	return <li className={cn(breadcrumbItemStyles, className)} data-slot="breadcrumb-item" {...props} />
}

export function BreadcrumbLink({
	className,
	render,
	...props
}: useRender.ComponentProps<"a">): React.ReactElement {
	const defaultProps = {
		className: cn(breadcrumbLinkStyles, className),
		"data-slot": "breadcrumb-link",
	}

	return useRender({
		defaultTagName: "a",
		props: mergeProps<"a">(defaultProps, props),
		render,
	})
}

export function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">): React.ReactElement {
	return (
		<span
			aria-current="page"
			className={cn(breadcrumbPageStyles, className)}
			data-slot="breadcrumb-page"
			{...props}
		/>
	)
}

export function BreadcrumbSeparator({
	children,
	className,
	...props
}: React.ComponentProps<"li">): React.ReactElement {
	return (
		<li
			aria-hidden="true"
			className={cn(breadcrumbSeparatorStyles, className)}
			data-slot="breadcrumb-separator"
			role="presentation"
			{...props}
		>
			{children ?? <ChevronRightIcon />}
		</li>
	)
}

export function BreadcrumbEllipsis({
	className,
	...props
}: React.ComponentProps<"span">): React.ReactElement {
	return (
		<span
			aria-hidden="true"
			className={className}
			data-slot="breadcrumb-ellipsis"
			role="presentation"
			{...props}
		>
			<DotsIcon className={breadcrumbEllipsisIconStyles} />
			<span className={breadcrumbEllipsisLabelStyles}>More</span>
		</span>
	)
}
