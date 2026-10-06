import { useClerk, useOrganization, useUser } from "@clerk/clerk-react"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Button } from "@maple/ui/components/ui/button"
import { ChevronExpandYIcon, LogoutIcon } from "@/components/icons"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { clearSelfHostedSessionToken } from "@/lib/services/common/self-hosted-auth"
import { ClerkOrgSwitcherMenu, OrgAvatar } from "@/components/dashboard/org-switcher-menu"
import { UserAvatar } from "@/components/dashboard/user-avatar"

const AVATAR_CLASS = "size-5 rounded-md text-[10px]"

export function OnboardingOrgSwitcher() {
	if (!isClerkAuthEnabled) return null
	return <OnboardingOrgSwitcherInner />
}

function OnboardingOrgSwitcherInner() {
	const { organization, isLoaded } = useOrganization()

	if (!isLoaded) return null

	const orgName = organization?.name ?? "Select organization"
	const orgImageUrl = organization?.imageUrl

	return (
		<ClerkOrgSwitcherMenu
			contentSide="bottom"
			contentAlign="end"
			trigger={
				<Button variant="outline" size="sm" className="pl-1.5 text-xs">
					<OrgAvatar name={orgName} imageUrl={orgImageUrl} className="size-5" />
					<span className="max-w-[10rem] truncate">{orgName}</span>
					<ChevronExpandYIcon size={12} className="ml-0.5 size-3 text-muted-foreground" />
				</Button>
			}
		/>
	)
}

export function OnboardingUserMenu() {
	if (isClerkAuthEnabled) return <ClerkUserMenu />
	return <SelfHostedUserMenu />
}

function ClerkUserMenu() {
	const { user, isLoaded } = useUser()
	const { signOut } = useClerk()

	if (!isLoaded) return null

	const name = user?.fullName ?? "Account"
	const email = user?.primaryEmailAddress?.emailAddress ?? ""
	const imageUrl = user?.imageUrl
	const initial = name.charAt(0).toUpperCase()

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button variant="outline" size="sm" className="pl-1 pr-2" aria-label="Account menu">
						<UserAvatar
							imageUrl={imageUrl}
							initials={initial}
							name={name}
							className={AVATAR_CLASS}
						/>
						<span className="sr-only">Account menu</span>
					</Button>
				}
			/>
			<DropdownMenuContent side="bottom" align="end" sideOffset={4} className="min-w-56">
				<DropdownMenuGroup>
					<DropdownMenuLabel>
						<div className="flex items-center gap-2 py-1 text-left text-sm">
							<UserAvatar
								imageUrl={imageUrl}
								initials={initial}
								name={name}
								className={AVATAR_CLASS}
							/>
							<div className="grid flex-1 text-left text-sm leading-tight">
								<span className="truncate font-medium">{name}</span>
								{email && (
									<span className="truncate text-xs text-muted-foreground">{email}</span>
								)}
							</div>
						</div>
					</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem onClick={() => signOut()}>
						<LogoutIcon size={16} />
						Log out
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function SelfHostedUserMenu() {
	const handleLogout = () => {
		clearSelfHostedSessionToken()
		window.location.assign("/sign-in")
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button variant="outline" size="sm" className="pl-1 pr-2" aria-label="Account menu">
						<UserAvatar initials="U" name="User" className={AVATAR_CLASS} />
						<span className="sr-only">Account menu</span>
					</Button>
				}
			/>
			<DropdownMenuContent side="bottom" align="end" sideOffset={4} className="min-w-44">
				<DropdownMenuGroup>
					<DropdownMenuItem onClick={handleLogout}>
						<LogoutIcon size={16} />
						Log out
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
