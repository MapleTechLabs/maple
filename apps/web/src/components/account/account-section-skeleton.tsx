import type { ReactNode } from "react"
import { Card, CardContent, CardHeader } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

/**
 * Placeholder a settings or account section renders while its Clerk resource loads.
 * `children` replaces the default single-input body.
 */
export function AccountSectionSkeleton({ children }: { children?: ReactNode }) {
	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<Skeleton className="h-5 w-32" />
					<Skeleton className="h-4 w-64" />
				</CardHeader>
				<CardContent>{children ?? <Skeleton className="h-9 w-full" />}</CardContent>
			</Card>
		</div>
	)
}
