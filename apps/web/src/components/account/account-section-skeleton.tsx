import type { ReactNode } from "react"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { SettingsSections } from "@/components/settings/settings-section"

/**
 * Placeholder a settings or account section renders while its Clerk resource loads, in the
 * `SettingsSection` shape. `children` replaces the default single-input body.
 */
export function AccountSectionSkeleton({ children }: { children?: ReactNode }) {
	return (
		<SettingsSections>
			<div className="flex flex-col gap-3">
				<div className="space-y-1.5">
					<Skeleton className="h-4 w-32" />
					<Skeleton className="h-4 w-64" />
				</div>
				<Panel padded>{children ?? <Skeleton className="h-9 w-full" />}</Panel>
			</div>
		</SettingsSections>
	)
}
