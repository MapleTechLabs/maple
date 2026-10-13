import type { ReactNode } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import type { IconComponent } from "@/components/icons/icon"

/** The detail-page rail card listing a resource's OTel attributes as `DetailRail.MetaRow`s. */
export function ResourceAttributesCard({
	icon: Icon,
	children,
	contentClassName,
}: {
	icon: IconComponent
	children: ReactNode
	contentClassName?: string
}) {
	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-sm font-medium">
					<Icon size={14} className="text-muted-foreground" />
					Resource attributes
				</CardTitle>
			</CardHeader>
			<CardContent className={contentClassName ?? "space-y-1"}>{children}</CardContent>
		</Card>
	)
}

const SKELETON_ROWS = [
	["w-12", "w-24"],
	["w-16", "w-28"],
	["w-10", "w-20"],
	["w-14", "w-32"],
	["w-12", "w-16"],
	["w-16", "w-24"],
] as const

/** Holds the detail rail's place while its summary loads, so the page doesn't reflow when it lands. */
export function ResourceAttributesCardSkeleton({ icon: Icon }: { icon: IconComponent }) {
	return (
		<Card aria-busy>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-sm font-medium">
					<Icon size={14} className="text-muted-foreground" />
					Resource attributes
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				{SKELETON_ROWS.map(([label, value], i) => (
					<div key={i} className="flex items-center justify-between gap-3">
						<Skeleton className={`h-2.5 ${label}`} />
						<Skeleton className={`h-2.5 ${value}`} />
					</div>
				))}
			</CardContent>
		</Card>
	)
}
