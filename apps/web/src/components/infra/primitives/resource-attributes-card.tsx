import type { ReactNode } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"

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
