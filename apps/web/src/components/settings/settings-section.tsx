import * as React from "react"

import { Panel } from "@maple/ui/components/ui/panel"
import { cn } from "@maple/ui/lib/utils"

import { SectionHeading } from "@/components/common/section-heading"

/**
 * One block of a settings page: heading, optional description and actions, then the
 * content in a `Panel`. Every section shares the fixed `max-w-3xl` column so tabs don't
 * jump width as you move between them. `framed={false}` for content that brings its
 * own frame (a table, a list of cards).
 */
export function SettingsSection({
	title,
	description,
	actions,
	framed = true,
	padded = true,
	className,
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
	children: React.ReactNode
}) {
	const id = React.useId()
	return (
		<section aria-labelledby={id} className={cn("flex w-full max-w-3xl flex-col gap-3", className)}>
			<div className="space-y-1">
				<SectionHeading id={id} title={title} actions={actions} />
				{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
			</div>
			{framed ? <Panel padded={padded}>{children}</Panel> : children}
		</section>
	)
}

/** Stacks a settings tab's sections at the shared rhythm. */
export function SettingsSections({ children }: { children: React.ReactNode }) {
	return <div className="flex w-full max-w-3xl flex-col gap-10">{children}</div>
}
