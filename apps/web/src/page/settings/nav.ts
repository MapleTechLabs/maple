import * as Policy from "@maple/domain/policy"
import { Array, Option } from "effect"
import type { NavShellRow, NavShellSection } from "../kit/nav-shell"
import type { settingsTabValues } from "../../route/search"

// The tab set, labels, nav groups and their visibility.

export type SettingsTab = (typeof settingsTabValues)[number]

export const settingsTabLabels = {
	general: "General",
	members: "Members",
	roles: "Roles",
	domains: "Verified domains",
	sso: "SSO & SCIM",
	billing: "Billing & usage",
	"audit-log": "Audit log",
	keys: "Keys",
	mcp: "MCP",
	ai: "AI",
	ingestion: "Ingestion",
	"data-platform": "Data platform",
	"data-sources": "Data sources",
	retention: "Retention",
	"setup-health": "Setup health",
	automation: "Automation",
} as const satisfies { readonly [Tab in SettingsTab]: string }

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
			tab("roles", "ShieldCheckIcon"),
			tab("domains", "GlobeIcon"),
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
			tab("sso", "ShieldIcon"),
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
			tab("data-sources", "PlugIcon"),
			tab("retention", "ClockIcon"),
			tab("setup-health", "CircleCheckIcon"),
		],
	},
	{ id: "alerting", title: "Alerting", items: [tab("automation", "BoltIcon")] },
]

export type Visibility = Readonly<{
	isClerk: boolean
	/** The session's permissions: every one off Clerk, none until the session answers. */
	grants: ReadonlyArray<Policy.Permission>
	canAccessDataPlatform: boolean
	/** The org's `dataSources` rollout flag. */
	hasDataSources: boolean
	/** An admin without the add-on: the row shows and opens a locked page naming the add-on. */
	isDataPlatformLocked?: boolean
}>

const isVisible = (id: string, visibility: Visibility): boolean => {
	if (id === "general" || id === "members" || id === "roles" || id === "billing") return visibility.isClerk
	// SSO lives in Clerk; every member reads it, admins change it.
	if (id === "sso") return visibility.isClerk
	// Clerk refuses a member reading the domains, so the tab is for admins only.
	if (id === "domains") return visibility.isClerk && Policy.can(visibility.grants, "organization:manage")
	// Retention is set per hosted organization; self-hosted Maple keeps its own.
	if (id === "retention") return visibility.isClerk
	if (!visibility.isClerk) return true
	if (id === "data-platform")
		return visibility.canAccessDataPlatform || visibility.isDataPlatformLocked === true
	if (id === "data-sources") return visibility.hasDataSources
	if (id === "audit-log") return Policy.can(visibility.grants, "audit_log:read")
	// The model provider and auto-triage each have their own permission; either opens the tab.
	if (id === "ai")
		return (
			Policy.can(visibility.grants, "llm_keys:manage") ||
			Policy.can(visibility.grants, "ai_triage:configure")
		)
	return true
}

export const visibleSections = (visibility: Visibility): ReadonlyArray<NavShellSection<SettingsTab>> =>
	Array.filter(
		Array.map(navSections, (section) => ({
			...section,
			items: Array.filter(section.items, (row) => isVisible(row.id, visibility)),
		})),
		(section) => section.items.length > 0,
	)

/** The tab rows only: `/integrations` is a route and never a fallback tab. */
export const visibleTabs = (
	sections: ReadonlyArray<NavShellSection<SettingsTab>>,
): ReadonlyArray<SettingsTab> =>
	Array.flatMap(sections, (section) =>
		Array.flatMap(section.items, (row) => (row.kind === "tab" ? [row.id] : [])),
	)

const DEFAULT_SETTINGS_TAB_ORDER: ReadonlyArray<SettingsTab> = ["general", "ingestion"]

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
