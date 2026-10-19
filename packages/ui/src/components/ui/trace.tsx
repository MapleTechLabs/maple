"use client"

import type React from "react"

import { ChevronRightIcon } from "../icons"
import { cn } from "../../lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible"
import {
	traceCollapsibleContentStyles,
	traceCollapsibleStyles,
	traceCollapsibleTriggerIconStyles,
	traceCollapsibleTriggerStyles,
	traceDescriptionStyles,
	traceIconStyles,
	traceLineStyles,
	traceStyles,
	traceTitleStyles,
} from "./trace.styles"

// shadcn's `trace` (https://ui.shadcn.com/docs/components/base/trace), ported onto this package's
// Collapsible and icons. The steps an agent takes: one line each, expandable into detail.

function Trace({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="trace" className={cn(traceStyles, className)} {...props} />
}

function TraceLine({
	className,
	status,
	...props
}: React.ComponentProps<"span"> & {
	status?: "running" | "error" | "pending"
}) {
	return (
		<span
			data-slot="trace-line"
			data-status={status}
			className={cn(traceLineStyles, className)}
			{...props}
		/>
	)
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="trace-icon"
			aria-hidden="true"
			className={cn(traceIconStyles, className)}
			{...props}
		/>
	)
}

function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
	return <span data-slot="trace-title" className={cn(traceTitleStyles, className)} {...props} />
}

function TraceDescription({ className, ...props }: React.ComponentProps<"span">) {
	return <span data-slot="trace-description" className={cn(traceDescriptionStyles, className)} {...props} />
}

function TraceCollapsible({
	className,
	...props
}: Omit<React.ComponentProps<typeof Collapsible>, "open" | "className"> & {
	className?: string
} & (
		| { open?: undefined }
		| {
				open: boolean
				onOpenChange: NonNullable<React.ComponentProps<typeof Collapsible>["onOpenChange"]>
		  }
	)) {
	return (
		<Collapsible
			data-slot="trace-collapsible"
			className={cn(traceCollapsibleStyles, className)}
			{...props}
		/>
	)
}

function TraceCollapsibleTrigger({
	className,
	children,
	...props
}: Omit<React.ComponentProps<typeof CollapsibleTrigger>, "className"> & { className?: string }) {
	return (
		<CollapsibleTrigger
			data-slot="trace-collapsible-trigger"
			className={cn(traceCollapsibleTriggerStyles, className)}
			{...props}
		>
			{children}
			<TraceIcon className={traceCollapsibleTriggerIconStyles}>
				<ChevronRightIcon />
			</TraceIcon>
		</CollapsibleTrigger>
	)
}

function TraceCollapsibleContent({ className, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
	return (
		<CollapsibleContent
			data-slot="trace-collapsible-content"
			className={cn(traceCollapsibleContentStyles, className)}
			{...props}
		/>
	)
}

export {
	Trace,
	TraceLine,
	TraceIcon,
	TraceTitle,
	TraceDescription,
	TraceCollapsible,
	TraceCollapsibleTrigger,
	TraceCollapsibleContent,
}
