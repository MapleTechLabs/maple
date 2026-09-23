import { useOrganization } from "@clerk/clerk-react"
import {
	organizationHomeRegion,
	organizationRegionChosen,
	organizationServedIn,
} from "@maple/domain/organization-regions"
import { useMemo } from "react"

import { currentRegion, type MapleRegion } from "@/lib/region"

export interface OrganizationRegionState {
	/** False until Clerk has loaded the active organization; draw no conclusion before then. */
	readonly isLoaded: boolean
	/** The region the active organization lives in. */
	readonly region: MapleRegion
	/** Whether this dashboard's region serves the active organization. */
	readonly servedHere: boolean
	/** False while the organization only has the US default, which onboarding asks about. */
	readonly chosen: boolean
}

/** The active organization's region, from its Clerk public metadata. Clerk mode only. */
export function useOrganizationRegion(): OrganizationRegionState {
	const { organization, isLoaded } = useOrganization()
	const metadata = organization?.publicMetadata
	return useMemo(
		() => ({
			isLoaded: isLoaded && organization !== undefined && organization !== null,
			region: organizationHomeRegion(metadata),
			servedHere: organizationServedIn(metadata, currentRegion),
			chosen: organizationRegionChosen(metadata),
		}),
		[isLoaded, organization, metadata],
	)
}
