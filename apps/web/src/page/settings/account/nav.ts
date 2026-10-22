import { accountTabValues } from "../../../route/search"
import type { NavShellSection } from "../kit/nav-shell"

// `accountNavSections`.

export type AccountTab = (typeof accountTabValues)[number]

export const accountTabLabels = {
	profile: "Profile",
	emails: "Email addresses",
	password: "Password",
	"two-factor": "Two-factor auth",
	passkeys: "Passkeys",
	connections: "Connected accounts",
	sessions: "Active sessions",
	"email-preferences": "Email preferences",
} as const satisfies { readonly [Tab in AccountTab]: string }

export const accountNavSections: ReadonlyArray<NavShellSection<AccountTab>> = [
	{
		id: "profile",
		title: "Profile",
		items: [
			{ kind: "tab", id: "profile", label: accountTabLabels.profile, icon: "UserIcon" },
			{ kind: "tab", id: "emails", label: accountTabLabels.emails, icon: "EnvelopeIcon" },
		],
	},
	{
		id: "security",
		title: "Security",
		items: [
			{ kind: "tab", id: "password", label: accountTabLabels.password, icon: "LockIcon" },
			{ kind: "tab", id: "two-factor", label: accountTabLabels["two-factor"], icon: "ShieldIcon" },
			{ kind: "tab", id: "passkeys", label: accountTabLabels.passkeys, icon: "FingerprintIcon" },
		],
	},
	{
		id: "access",
		title: "Access",
		items: [
			{ kind: "tab", id: "connections", label: accountTabLabels.connections, icon: "LinkIcon" },
			{ kind: "tab", id: "sessions", label: accountTabLabels.sessions, icon: "ComputerIcon" },
		],
	},
	{
		id: "notifications",
		title: "Notifications",
		items: [
			{
				kind: "tab",
				id: "email-preferences",
				label: accountTabLabels["email-preferences"],
				icon: "BellIcon",
			},
		],
	},
]

/** `resolveActiveAccountTab`: every tab is visible to any signed-in user; profile by default. */
export const resolveActiveAccountTab = (requested: string | undefined): AccountTab =>
	accountTabValues.find((tab) => tab === requested) ?? "profile"
