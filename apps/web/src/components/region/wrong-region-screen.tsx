import { useOrganization } from "@clerk/clerk-react"
import { useRouterState } from "@tanstack/react-router"
import { Button } from "@maple/ui/components/ui/button"

import { AuthLayout } from "@/components/layout/auth-layout"
import { ClerkOrgSwitcherMenu } from "@/components/dashboard/org-switcher-menu"
import { currentRegion, MAPLE_REGION_LABELS, type MapleRegion, regionAppUrl } from "@/lib/region"

/**
 * Shown instead of the app when the active organization lives in another region. Each region is
 * a separate Maple with its own data, so this one has nothing to show for it.
 */
export function WrongRegionScreen({ region }: { region: MapleRegion }) {
	const { organization } = useOrganization()
	const href = useRouterState({ select: (s) => s.location.href })
	const orgName = organization?.name ?? "This organization"
	const target = MAPLE_REGION_LABELS[region]
	const here = MAPLE_REGION_LABELS[currentRegion]
	const url = regionAppUrl(region)

	return (
		<AuthLayout maxWidth="max-w-lg">
			<AuthLayout.Title>
				{orgName} is in the {target.short} region
			</AuthLayout.Title>
			<AuthLayout.Description>
				Its data is stored in the {target.name}. You are on the {here.short} dashboard, which keeps a
				separate set of organizations.
			</AuthLayout.Description>
			<div className="mt-6 flex flex-wrap items-center gap-2">
				{url !== undefined && (
					<Button render={<a href={`${url}${href}`} />}>Open in {target.short}</Button>
				)}
				<ClerkOrgSwitcherMenu trigger={<Button variant="outline">Switch organization</Button>} />
			</div>
		</AuthLayout>
	)
}
