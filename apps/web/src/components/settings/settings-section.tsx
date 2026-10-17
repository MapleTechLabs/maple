import * as React from "react"

import { Panel } from "@maple/ui/components/ui/panel"
import { cn } from "@maple/ui/lib/utils"

import { SectionHeading } from "@/components/common/section-heading"

/**
 * Column width of a settings tab. `standard` is the shared `max-w-3xl` reading column; `wide`
 * takes the full content width, for table-led tabs (members, keys, audit log).
 */
export type SettingsWidth = "standard" | "wide"

const widthClass = (width: SettingsWidth) => (width === "wide" ? "w-full" : "w-full max-w-3xl")

/**
 * One block of a settings page: heading, optional description and actions, then the
 * content in a `Panel`. Sections share one column width per tab so tabs don't jump width
 * as you move between them. `framed={false}` for content that brings its own frame.
 */
export function SettingsSection({
	title,
	description,
	actions,
	framed = true,
	padded = true,
	className,
	footer,
	width = "standard",
	anchorId,
	children,
}: {
	title: string
	description?: React.ReactNode
	/** Right of the heading: the section's primary action. */
	actions?: React.ReactNode
	framed?: boolean
	/** Panel padding when framed; off for a panel of `SettingRow`s that pad themselves. */
	padded?: boolean
	className?: string
	/** Below the content, e.g. an `AdminOnlyNote` explaining controls a member cannot use. */
	footer?: React.ReactNode
	width?: SettingsWidth
	/** Fragment target for deep links like `?tab=ingestion#sampling`. */
	anchorId?: string
	children: React.ReactNode
}) {
	const id = React.useId()
	return (
		<section
			id={anchorId}
			aria-labelledby={id}
			className={cn("flex scroll-mt-6 flex-col gap-3", widthClass(width), className)}
		>
			<div className="space-y-1">
				<SectionHeading id={id} title={title} actions={actions} />
				{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
			</div>
			{framed ? <Panel padded={padded}>{children}</Panel> : children}
			{footer}
		</section>
	)
}

/** Stacks a settings tab's sections at the shared rhythm. */
export function SettingsSections({
	width = "standard",
	children,
}: {
	/** `wide` for table-led tabs; give their sections `width="wide"` too. */
	width?: SettingsWidth
	children: React.ReactNode
}) {
	return <div className={cn("flex flex-col gap-10", widthClass(width))}>{children}</div>
}

/** The one-line reason beside a control a member sees but cannot use. */
export function AdminOnlyNote({ children, className }: { children: React.ReactNode; className?: string }) {
	return <p className={cn("text-xs text-muted-foreground", className)}>{children}</p>
}
