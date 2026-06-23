import type React from "react"

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { cn } from "@maple/ui/lib/utils"
import { CheckIcon } from "@/components/icons"
import { IntegrationIconPlate } from "./integration-catalog"

/**
 * Brand take on `EmptyMedia variant="icon"`: a brand-washed icon plate with two
 * plain plates fanned behind it (the same ±10° / scale geometry the shared Empty
 * media uses), so every integration empty state reads as one family.
 */
function IntegrationEmptyMedia({
	icon,
	accent,
	iconClassName,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>
	accent: string
	iconClassName?: string
}) {
	const backer = "absolute bottom-px size-12 rounded-xl border border-border/60 bg-card shadow-none"
	return (
		<div className="relative mb-6 flex items-end justify-center">
			<span
				aria-hidden
				className={cn(backer, "origin-bottom-left -translate-x-1.5 -rotate-10 scale-90")}
			/>
			<span
				aria-hidden
				className={cn(backer, "origin-bottom-right translate-x-1.5 rotate-10 scale-90")}
			/>
			<IntegrationIconPlate
				icon={icon}
				accent={accent}
				iconClassName={iconClassName}
				size={24}
				plateClassName="relative size-12 rounded-xl shadow-sm"
			/>
		</div>
	)
}

/**
 * The shared integration empty state — one shape for every drill-in's not-connected /
 * no-items view: brand triple-stacked icon, title, description, optional value bullets,
 * a primary action, and optional helper text. Keeps GitHub/Hazel/Cloudflare/scrape aligned.
 */
export function IntegrationEmptyState({
	icon,
	accent,
	iconClassName,
	title,
	description,
	features,
	children,
	footer,
	className,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>
	accent: string
	iconClassName?: string
	title: string
	description: React.ReactNode
	/** Optional value-prop bullets (GitHub-style), each with a leading check. */
	features?: ReadonlyArray<string>
	/** Primary action(s). */
	children?: React.ReactNode
	/** Helper text shown under the action. */
	footer?: React.ReactNode
	className?: string
}) {
	return (
		<Empty className={cn("rounded-lg border border-border/60 bg-card py-12 md:py-12", className)}>
			<EmptyHeader>
				<IntegrationEmptyMedia icon={icon} accent={accent} iconClassName={iconClassName} />
				<EmptyTitle className="text-base">{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>

			{features && features.length > 0 ? (
				<ul className="flex w-full max-w-sm flex-col gap-2 text-left text-sm text-muted-foreground">
					{features.map((feature) => (
						<li key={feature} className="flex items-start gap-2">
							<CheckIcon size={16} className="mt-0.5 shrink-0 text-success-foreground" />
							<span>{feature}</span>
						</li>
					))}
				</ul>
			) : null}

			{children || footer ? (
				<EmptyContent>
					{children}
					{footer ? <p className="text-xs text-muted-foreground">{footer}</p> : null}
				</EmptyContent>
			) : null}
		</Empty>
	)
}
