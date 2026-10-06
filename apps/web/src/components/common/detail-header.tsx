import * as React from "react"

import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { DashboardLayout } from "@/components/layout/dashboard-layout"

/** "kind" or ["kind", "subtype"]: the segments of a detail header's eyebrow. */
export type DetailKind = React.ReactNode | ReadonlyArray<React.ReactNode>

function isKindTrail(kind: DetailKind): kind is ReadonlyArray<React.ReactNode> {
	return Array.isArray(kind)
}

/** The eyebrow of a detail header, segments joined by a quiet dot. Shared by page and sheet headers. */
export function DetailEyebrow({ kind, className }: { kind: DetailKind; className?: string }) {
	const segments = (isKindTrail(kind) ? kind : [kind]).filter(
		(segment) => segment !== null && segment !== undefined && segment !== false && segment !== "",
	)
	if (segments.length === 0) return null
	return (
		<Eyebrow as="div" className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
			{segments.map((segment, index) => (
				<React.Fragment key={index}>
					{index > 0 ? (
						<span aria-hidden className="text-muted-foreground/40">
							·
						</span>
					) : null}
					<span className="truncate">{segment}</span>
				</React.Fragment>
			))}
		</Eyebrow>
	)
}

/**
 * A detail page's header: kind eyebrow, the one `<h1>`, a status/meta row, and the
 * actions (one labelled primary plus an overflow menu, by convention). The page
 * counterpart of `SheetDetailHeader`, with the same slot names.
 */
export function DetailHeader({
	kind,
	title,
	titleText,
	adornment,
	meta,
	actions,
}: {
	/** "Investigation" or ["Investigation", "Error spike"]. */
	kind?: DetailKind
	title: React.ReactNode
	/** Tooltip for the truncating title; defaults to `title` when it is a string. */
	titleText?: string
	/** Inline beside the title (a service dot, a small badge). */
	adornment?: React.ReactNode
	/** The chip row under the title: status, severity, scope. */
	meta?: React.ReactNode
	actions?: React.ReactNode
}) {
	const tooltip = titleText ?? (typeof title === "string" ? title : undefined)
	return (
		<DashboardLayout.Header
			titleContent={
				<div className="min-w-0 space-y-2.5">
					{kind !== undefined ? <DetailEyebrow kind={kind} /> : null}
					<DashboardLayout.Title
						title={tooltip}
						className={adornment ? "flex items-center gap-2.5" : undefined}
					>
						{adornment ? <span className="truncate">{title}</span> : title}
						{adornment}
					</DashboardLayout.Title>
					{meta ? <div className="flex flex-wrap items-center gap-2">{meta}</div> : null}
				</div>
			}
		>
			{actions ? <div className="flex items-center gap-2">{actions}</div> : null}
		</DashboardLayout.Header>
	)
}

/** `DetailHeader`'s loading frame, sized to the real one so the body doesn't jump. */
export function DetailHeaderSkeleton({ meta = true, actions }: { meta?: boolean; actions?: React.ReactNode }) {
	return (
		<DashboardLayout.Header
			titleContent={
				<div className="min-w-0 space-y-2.5" aria-busy>
					<Skeleton className="h-3 w-32" />
					<Skeleton className="h-7 w-3/4" />
					{meta ? <Skeleton className="h-5 w-48" /> : null}
				</div>
			}
		>
			{actions}
		</DashboardLayout.Header>
	)
}
