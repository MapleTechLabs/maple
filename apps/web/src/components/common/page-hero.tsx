import * as React from "react"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

/**
 * In-body page title for pages whose header row is a breadcrumb (infra, detail
 * pages). Typography matches `PageLayout.Title` so a hero and a layout header
 * read as the same heading.
 */
interface PageHeroProps {
	title: React.ReactNode
	description?: React.ReactNode
	meta?: React.ReactNode
	actions?: React.ReactNode
	trailing?: React.ReactNode
	className?: string
}

export function PageHero({ title, description, meta, actions, trailing, className }: PageHeroProps) {
	return (
		<header className={cn("flex flex-wrap items-start gap-x-6 gap-y-3", className)}>
			<div className="min-w-0 flex-1 space-y-1">
				<div className="flex flex-wrap items-baseline gap-3">
					<h1 className="font-display text-2xl font-semibold leading-[1.1] tracking-tight text-foreground">
						{title}
					</h1>
					{trailing}
				</div>
				{description ? (
					<p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
				) : null}
				{meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
			</div>
			{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
		</header>
	)
}

export function HeroChip({ children }: { children: React.ReactNode }) {
	return (
		<Badge variant="meta" size="xs" mono>
			{children}
		</Badge>
	)
}
