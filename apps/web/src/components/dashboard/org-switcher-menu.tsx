import { lazy, Suspense, useState, type ReactElement } from "react"
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
import { organizationHomeRegion, organizationRegionOpen } from "@maple/domain/organization-regions"
import { RegionBadge } from "@/components/region/region-badge"
import { currentRegion, hasMultipleRegions, regionAppUrl } from "@/lib/region"
import { NamespaceScopeSubmenu } from "./namespace-scope-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { LoadMoreButton } from "@maple/ui/components/ui/list-footer"
import { initialsFrom } from "@maple/ui/lib/initials"
import { cn } from "@maple/ui/lib/utils"

// Opened from a menu item, so its form, radio group and validation stay out of startup.
const CreateOrganizationDialog = lazy(() =>
	import("./create-organization-dialog").then((module) => ({ default: module.CreateOrganizationDialog })),
)

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
	return (
		<Avatar className={cn("size-8 rounded-md bg-transparent", className)}>
			{imageUrl && (
				<AvatarImage
					src={imageUrl}
					alt={name}
					className={fit === "contain" ? "object-contain" : "object-cover"}
				/>
			)}
			<AvatarFallback className="rounded-[inherit] bg-primary text-primary-foreground text-xs font-semibold">
				{initialsFrom(name)}
			</AvatarFallback>
		</Avatar>
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
								<span className="truncate" title={mem.organization.name}>
									{mem.organization.name}
								</span>
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
										className={hasMultipleRegions ? undefined : "ml-auto"}
									/>
								)}
							</DropdownMenuItem>
						))}
						{userMemberships?.hasNextPage && (
							<LoadMoreButton
								variant="ghost"
								className="w-full text-xs"
								loading={userMemberships.isFetching}
								onClick={() => userMemberships.fetchNext?.()}
							/>
						)}
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuItem onClick={() => setShowCreateDialog(true)}>
							<PlusIcon />
							Create Organization
						</DropdownMenuItem>
					</DropdownMenuGroup>
					{namespaceScope && <NamespaceScopeSubmenu />}
				</DropdownMenuContent>
			</DropdownMenu>

			<Suspense fallback={null}>
				{showCreateDialog && <CreateOrganizationDialog open onOpenChange={setShowCreateDialog} />}
			</Suspense>
		</>
	)
}
