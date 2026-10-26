import { Array, Option } from "effect"
import type { NavShellRow, NavShellSection } from "./kit/nav-shell"
import { legacySettingsTabValues, settingsTabValues } from "../../route/search"

// The tab set, labels, retired-tab redirects, nav groups and their visibility.

export type SettingsTab = (typeof settingsTabValues)[number]
export type LegacySettingsTab = (typeof legacySettingsTabValues)[number]

export const settingsTabLabels = {
	general: "General",
	members: "Members",
	billing: "Billing & usage",
	"audit-log": "Audit log",
	keys: "Keys",
	mcp: "MCP",
	ai: "AI",
	ingestion: "Ingestion",
	"data-platform": "Data platform",
	"setup-health": "Setup health",
	automation: "Automation",
} as const satisfies { readonly [Tab in SettingsTab]: string }

export type LegacySettingsRedirect =
	| { readonly kind: "tab"; readonly tab: SettingsTab }
	| { readonly kind: "integrations" }
	| { readonly kind: "account" }

const legacyRedirects = {
	organization: { kind: "tab", tab: "general" },
	"api-keys": { kind: "tab", tab: "keys" },
	"ai-provider": { kind: "tab", tab: "ai" },
	"setup-audit": { kind: "tab", tab: "setup-health" },
	notifications: { kind: "account" },
	connectors: { kind: "integrations" },
	integrations: { kind: "integrations" },
	escalations: { kind: "tab", tab: "automation" },
	developer: { kind: "tab", tab: "keys" },
} as const satisfies { readonly [Tab in LegacySettingsTab]: LegacySettingsRedirect }

/** Where a retired `?tab=` value now lives (`resolveLegacySettingsTab`). */
export const resolveLegacySettingsTab = (tab: string | undefined): Option.Option<LegacySettingsRedirect> =>
	Option.map(
		Array.findFirst(legacySettingsTabValues, (value) => value === tab),
		(legacy) => legacyRedirects[legacy],
	)

const tab = (id: SettingsTab, icon: NavShellRow<SettingsTab>["icon"]): NavShellRow<SettingsTab> => ({
	kind: "tab",
	id,
	label: settingsTabLabels[id],
	icon,
})

const navSections: ReadonlyArray<NavShellSection<SettingsTab>> = [
	{
		id: "workspace",
		title: "Workspace",
		items: [
			tab("general", "GearIcon"),
			tab("members", "UserIcon"),
			tab("billing", "CreditCardIcon"),
			tab("audit-log", "HistoryIcon"),
		],
	},
	{
		id: "access",
		title: "Access",
		items: [
			{
				kind: "link",
				id: "integrations",
				label: "Integrations",
				icon: "GridIcon",
				href: "/integrations",
			},
			tab("keys", "KeyIcon"),
			tab("mcp", "SquareTerminalIcon"),
			tab("ai", "ChatBubbleSparkleIcon"),
		],
	},
	{
		id: "data",
		title: "Data",
		items: [
			tab("ingestion", "ServerIcon"),
			tab("data-platform", "DatabaseIcon"),
			tab("setup-health", "CircleCheckIcon"),
		],
	},
	{ id: "alerting", title: "Alerting", items: [tab("automation", "BoltIcon")] },
]

export type Visibility = Readonly<{
	isClerk: boolean
	isAdmin: boolean
	canAccessDataPlatform: boolean
}>

const isVisible = (id: string, visibility: Visibility): boolean => {
	if (id === "general" || id === "members" || id === "billing") return visibility.isClerk
	if (!visibility.isClerk) return true
	if (id === "data-platform") return visibility.canAccessDataPlatform
	if (id === "audit-log" || id === "ai") return visibility.isAdmin
	return true
}

/** `useVisibleSettingsSections().visibleSections`. */
export const visibleSections = (visibility: Visibility): ReadonlyArray<NavShellSection<SettingsTab>> =>
	navSections
		.map((section) => ({
			...section,
			items: section.items.filter((row) => isVisible(row.id, visibility)),
		}))
		.filter((section) => section.items.length > 0)

/** The tab rows only: `/integrations` is a route and never a fallback tab. */
export const visibleTabs = (
	sections: ReadonlyArray<NavShellSection<SettingsTab>>,
): ReadonlyArray<SettingsTab> =>
	sections.flatMap((section) => section.items.flatMap((row) => (row.kind === "tab" ? [row.id] : [])))

const DEFAULT_SETTINGS_TAB_ORDER: ReadonlyArray<SettingsTab> = ["general", "ingestion"]

/** `resolveActiveSettingsTab`. */
export const resolveActiveSettingsTab = (
	requested: string | undefined,
	tabs: ReadonlyArray<SettingsTab>,
): SettingsTab =>
	Option.getOrElse(
		Option.orElse(
			Array.findFirst(tabs, (id) => id === requested),
			() => Array.findFirst(DEFAULT_SETTINGS_TAB_ORDER, (id) => tabs.includes(id)),
		),
		() => tabs[0] ?? "ingestion",
	)
