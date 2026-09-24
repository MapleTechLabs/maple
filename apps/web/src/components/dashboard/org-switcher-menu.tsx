import { useState, type ReactElement } from "react"
import { useOrganization, useOrganizationList } from "@clerk/clerk-react"
import { CheckIcon, PlusIcon } from "@/components/icons"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { CreateOrganizationDialog } from "./create-organization-dialog"
import { organizationHomeRegion, organizationRegionOpen } from "@maple/domain/organization-regions"
import { RegionBadge } from "@/components/region/region-badge"
import { currentRegion, hasMultipleRegions, regionAppUrl } from "@/lib/region"
import { NamespaceScopeSubmenu } from "./namespace-scope-menu"

export function OrgAvatar({
	name,
	imageUrl,
	className,
	fit = "cover",
}: {
	name: string
	imageUrl?: string | null
	className?: string
	/** How the logo image fills its box. "cover" (default) crops to a square for compact avatars;
	 * "contain" shows the full logo undistorted (used in the settings preview). */
	fit?: "cover" | "contain"
}) {
	const initial = name.charAt(0).toUpperCase()
	const baseClass = className ?? "size-8"
	return imageUrl ? (
		<img
			src={imageUrl}
			alt={name}
			className={`${baseClass} shrink-0 rounded-md ${fit === "contain" ? "object-contain" : "object-cover"}`}
		/>
	) : (
		<div
			className={`${baseClass} flex shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-semibold`}
		>
			{initial}
		</div>
	)
}

export function ClerkOrgSwitcherMenu({
	trigger,
	contentSide = "bottom",
	contentAlign = "start",
	namespaceScope = false,
}: {
	trigger: ReactElement
	contentSide?: "top" | "right" | "bottom" | "left"
	contentAlign?: "start" | "center" | "end"
	/** Show the org-global namespace switch. Off by default — this menu is also
	 * reused by auth flows (CLI login, MCP authorize, onboarding). */
	namespaceScope?: boolean
}) {
	const { organization } = useOrganization()
	const { userMemberships, setActive } = useOrganizationList({
		userMemberships: { infinite: true },
	})
	const [showCreateDialog, setShowCreateDialog] = useState(false)

	const switchOrganization = async (next: {
		readonly id: string
		readonly publicMetadata: unknown
		readonly createdAt: Date
	}) => {
		if (!setActive || organization?.id === next.id) return
		await setActive({ organization: next.id })
		// The session is shared across regions, so the other region's dashboard opens on this org.
		// One that can still choose its region stays here, where onboarding asks for it.
		const region = organizationHomeRegion(next.publicMetadata)
		const open = organizationRegionOpen(next.publicMetadata, next.createdAt.getTime(), Date.now())
		const url = open || region === currentRegion ? undefined : regionAppUrl(region)
		if (url !== undefined) window.location.assign(`${url}/`)
		else window.location.reload()
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger render={trigger} />
				<DropdownMenuContent
					side={contentSide}
					align={contentAlign}
					sideOffset={4}
					className="min-w-56"
				>
					<DropdownMenuGroup>
						<DropdownMenuLabel>Organizations</DropdownMenuLabel>
						{userMemberships?.data?.map((mem) => (
							<DropdownMenuItem
								key={mem.organization.id}
								onClick={() => void switchOrganization(mem.organization)}
							>
								<OrgAvatar
									name={mem.organization.name}
									imageUrl={mem.organization.imageUrl}
								/>
								<span className="truncate">{mem.organization.name}</span>
								{hasMultipleRegions &&
									!organizationRegionOpen(
										mem.organization.publicMetadata,
										mem.organization.createdAt.getTime(),
										Date.now(),
									) && (
										<RegionBadge
											region={organizationHomeRegion(mem.organization.publicMetadata)}
											className="ml-auto"
										/>
									)}
								{organization?.id === mem.organization.id && (
									<CheckIcon
										size={16}
										className={hasMultipleRegions ? undefined : "ml-auto"}
									/>
								)}
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuItem onClick={() => setShowCreateDialog(true)}>
							<PlusIcon size={16} />
							Create Organization
						</DropdownMenuItem>
					</DropdownMenuGroup>
					{namespaceScope && <NamespaceScopeSubmenu />}
				</DropdownMenuContent>
			</DropdownMenu>

			<CreateOrganizationDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} />
		</>
	)
}
