import { useMapleCustomer } from "@/hooks/use-maple-customer"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { hasBringYourOwnCloudAddOn } from "@/lib/billing/plan-gating"
import { useOrganizationFeatureFlags } from "@/hooks/use-organization-feature-flags"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { retainedQuery } from "@/lib/services/common/atom-client"
import {
	ChatBubbleSparkleIcon,
	CircleCheckIcon,
	CreditCardIcon,
	DatabaseIcon,
	GearIcon,
	GridIcon,
	HistoryIcon,
	KeyIcon,
	ServerIcon,
	ShieldIcon,
	SquareTerminalIcon,
	UserIcon,
	type IconComponent,
} from "@/components/icons"
import { SettingsNavShell } from "@/components/settings/settings-nav-shell"

export const settingsTabValues = [
	"general",
	"members",
	"billing",
	"audit-log",
	"keys",
	"mcp",
	"ai",
	"ingestion",
	"data-platform",
	"setup-health",
	"automation",
] as const
export type SettingsTab = (typeof settingsTabValues)[number]

export const settingsTabLabels: Record<SettingsTab, string> = {
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
} satisfies Record<SettingsTab, string>

/**
 * Retired `?tab=` values and where each one lives now, so old deep links (emails, docs, bookmarks)
 * keep working. A redirect is either another settings tab or a different page entirely.
 */
export type LegacySettingsRedirect =
	| { readonly kind: "tab"; readonly tab: SettingsTab }
	| { readonly kind: "integrations" }
	| { readonly kind: "account"; readonly tab: "email-preferences" }

export const legacySettingsTabValues = [
	"organization",
	"api-keys",
	"ai-provider",
	"setup-audit",
	"notifications",
	"connectors",
	"integrations",
	"escalations",
	"developer",
] as const
export type LegacySettingsTab = (typeof legacySettingsTabValues)[number]

export const legacySettingsTabRedirects = {
	organization: { kind: "tab", tab: "general" },
	"api-keys": { kind: "tab", tab: "keys" },
	"ai-provider": { kind: "tab", tab: "ai" },
	"setup-audit": { kind: "tab", tab: "setup-health" },
	notifications: { kind: "account", tab: "email-preferences" },
	connectors: { kind: "integrations" },
	integrations: { kind: "integrations" },
	escalations: { kind: "tab", tab: "automation" },
	// "API reference" became the reference block at the foot of the Keys tab.
	developer: { kind: "tab", tab: "keys" },
} satisfies Record<LegacySettingsTab, LegacySettingsRedirect>

/** Where a retired `?tab=` value now lives, or undefined for a current (or unknown) value. */
export function resolveLegacySettingsTab(tab: string | undefined): LegacySettingsRedirect | undefined {
	const legacy = legacySettingsTabValues.find((value) => value === tab)
	return legacy === undefined ? undefined : legacySettingsTabRedirects[legacy]
}

interface NavItem {
	id: SettingsTab
	label: string
	icon: IconComponent
}

/**
 * Preference order for the landing tab when `/settings` is opened with no `?tab=`, most-preferred
 * first. `general` is the Clerk-workspace landing tab; `ingestion` is the self-hosted one, where
 * `general` is filtered out.
 *
 * This is declared rather than inferred from nav position on purpose: a positional default silently
 * moves whenever an item is added. `setup-health` is deliberately not Clerk-gated, so in self-hosted
 * mode a positional default could land on it and run the audit's dozen warehouse reads on every
 * visit to Settings.
 *
 * Never list a tab here whose section does expensive work on mount.
 */
export const DEFAULT_SETTINGS_TAB_ORDER: ReadonlyArray<SettingsTab> = ["general", "ingestion"]

/**
 * Which tab `/settings` should render: the requested one when it is actually visible, else the first
 * available preferred default, else whatever is on offer.
 */
export function resolveActiveSettingsTab(
	requestedTab: string | undefined,
	visibleItems: ReadonlyArray<NavItem>,
): SettingsTab {
	const requested = visibleItems.find((item) => item.id === requestedTab)?.id
	if (requested !== undefined) return requested
	const preferred = DEFAULT_SETTINGS_TAB_ORDER.find((tab) => visibleItems.some((item) => item.id === tab))
	return preferred ?? visibleItems[0]?.id ?? "ingestion"
}

/** Sibling pages that share the settings shell (rendered as router Links). */
interface NavLinkItem {
	id: "integrations"
	label: string
	icon: IconComponent
	to: string
}

export interface SettingsNavSection {
	id: "workspace" | "access" | "data" | "alerting"
	title: string
	/** Tabs and sibling-page links in one ordered list: nav position is declared, not derived. */
	items: Array<NavItem | NavLinkItem>
}

/**
 * Four groups, each earning its header: who can use the workspace and what it costs; what can reach
 * Maple from outside (integrations, keys, agents); where telemetry comes from and where it lands; and what Maple does when
 * something breaks.
 *
 * Group order does not decide the landing tab; `DEFAULT_SETTINGS_TAB_ORDER` does, on purpose.
 *
 * Within a group, rows run most-visited first rather than alphabetically.
 */
const navSections: SettingsNavSection[] = [
	{
		id: "workspace",
		title: "Workspace",
		items: [
			{ id: "general", label: settingsTabLabels.general, icon: GearIcon },
			{ id: "members", label: settingsTabLabels.members, icon: UserIcon },
			{ id: "billing", label: settingsTabLabels.billing, icon: CreditCardIcon },
			{ id: "audit-log", label: settingsTabLabels["audit-log"], icon: HistoryIcon },
		],
	},
	{
		id: "access",
		title: "Access",
		items: [
			// A sibling page rather than a tab, and the most-visited row in the nav, so it leads its
			// group. Nothing about it being a route should push it down the list.
			{ id: "integrations", label: "Integrations", icon: GridIcon, to: "/integrations" },
			{ id: "keys", label: settingsTabLabels.keys, icon: KeyIcon },
			{ id: "mcp", label: settingsTabLabels.mcp, icon: SquareTerminalIcon },
			{ id: "ai", label: settingsTabLabels.ai, icon: ChatBubbleSparkleIcon },
		],
	},
	{
		id: "data",
		title: "Data",
		items: [
			{ id: "ingestion", label: settingsTabLabels.ingestion, icon: ServerIcon },
			{ id: "data-platform", label: settingsTabLabels["data-platform"], icon: DatabaseIcon },
			// A diagnostic over everything that feeds Maple, so it closes the group it reports on.
			{ id: "setup-health", label: settingsTabLabels["setup-health"], icon: CircleCheckIcon },
		],
	},
	{
		id: "alerting",
		title: "Alerting",
		items: [
			// Temporary home for escalation until the alerts routing redesign ships.
			{ id: "automation", label: settingsTabLabels.automation, icon: ShieldIcon },
		],
	},
]

/**
 * The tab rows of a section list, dropping sibling-page links. `visibleItems` feeds tab resolution,
 * and `/integrations` is a route rather than a tab: it must never surface as a fallback tab id.
 */
const tabItems = (sections: ReadonlyArray<SettingsNavSection>): ReadonlyArray<NavItem> =>
	sections.flatMap((section) => section.items.filter((row): row is NavItem => !("to" in row)))

/**
 * Permission-filtered settings nav sections, shared by /settings and the
 * /integrations hub (which renders the same sidebar).
 */
export function useVisibleSettingsSections() {
	// Hooks run unconditionally (rules of hooks); their results are only consumed
	// in the Clerk-auth path below. `isClerkAuthEnabled` is a build-time constant
	// today, but keeping the hooks above the early return avoids a conditional-hook
	// hazard if it ever becomes dynamic.
	const sessionResult = useAtomValue(retainedQuery("auth", "session", {}))
	const isAdmin = useIsOrgAdmin()
	const { data: customer, isLoading: isCustomerLoading } = useMapleCustomer()
	// Shared with the main sidebar and the flagged routes, so a flag can't be read
	// one way here and another way there (it already force-enables when self-hosted,
	// which is what the `!isClerkAuthEnabled` branch below used to do inline).
	const { flags: featureFlags } = useOrganizationFeatureFlags()

	const visibleSections = navSections
		.map((section) => ({
			...section,
			items: section.items.filter((item) => {
				if (item.id === "general" || item.id === "members" || item.id === "billing") {
					return isClerkAuthEnabled
				}
				return true
			}),
		}))
		.filter((section) => section.items.length > 0)

	if (!isClerkAuthEnabled) {
		return {
			visibleSections,
			visibleItems: tabItems(visibleSections),
			isAdmin: true,
			canAccessDataPlatform: true,
			canAccessAi: true,
			isCustomerLoading: false,
			isLoading: false,
		}
	}

	const canAccessDataPlatform = isAdmin && hasBringYourOwnCloudAddOn(customer)
	const canAccessAi = isAdmin && featureFlags.aiAutoTriage

	const dataSections = navSections
		.map((section) => ({
			...section,
			items: section.items.filter((item) => {
				if (item.id === "data-platform") return canAccessDataPlatform
				// `GET /v2/audit_log` is admin-only; hide the tab rather than let a
				// member open it into a 403.
				if (item.id === "audit-log") return isAdmin
				// Only admins can attach the add-on or manage the key.
				if (item.id === "ai") return isAdmin
				return true
			}),
		}))
		.filter((section) => section.items.length > 0)

	return {
		visibleSections: dataSections,
		visibleItems: tabItems(dataSections),
		isAdmin,
		canAccessDataPlatform,
		canAccessAi,
		isCustomerLoading,
		// The shell only waits on the (fast) session query. The billing customer -
		// dominated by an upstream Autumn round-trip: keeps loading in the
		// background; `canAccessDataPlatform` stays false until it resolves, so the
		// "Data platform" nav item just appears when ready (same as /integrations),
		// instead of blocking the whole page behind it.
		isLoading: Result.isInitial(sessionResult),
	}
}

export function SettingsNav({
	sections,
	active,
	onSelectTab,
}: {
	sections: SettingsNavSection[]
	/** Active settings tab, or "integrations" when the hub page renders the nav. */
	active: SettingsTab | "integrations"
	onSelectTab: (tab: SettingsTab) => void
}) {
	return <SettingsNavShell sections={sections} active={active} onSelectTab={onSelectTab} />
}
