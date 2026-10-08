import { Navigate, useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardPage } from "@/components/layout/dashboard-page"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { EmptyMessage } from "@maple/ui/components/ui/empty"

import { BillingSection } from "@/components/settings/billing-section"
import { MembersSection } from "@/components/settings/members-section"
import { IngestionSection } from "@/components/settings/ingestion-section"
import { ApiKeysSection } from "@/components/settings/api-keys-section"
import { AuditLogSection } from "@/components/settings/audit-log-section"
import { McpSection } from "@/components/settings/mcp-section"
import { NotificationsSection } from "@/components/settings/notifications-section"
import { AutomationSection } from "@/components/settings/automation-section"
import { OrgClickHouseSettingsSection } from "@/components/settings/org-clickhouse-settings-section"
import { OrganizationSection } from "@/components/settings/organization-section"
import { SetupAuditSection } from "@/components/settings/setup-audit-section"
import {
	resolveActiveSettingsTab,
	SettingsNav,
	settingsTabLabels,
	settingsTabValues,
	useVisibleSettingsSections,
	type SettingsTab,
} from "@/components/settings/settings-nav"

/** Retired tabs — kept decodable so old deep links redirect instead of landing on a blank page. */
const legacyTabValues = ["connectors", "integrations", "escalations", "ai", "developer"] as const

const SettingsSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals([...settingsTabValues, ...legacyTabValues])),
	// Stripe Checkout return marker — see `lib/billing/checkout-return.ts`.
	checkout: Schema.optional(Schema.Literal("complete")),
})

export const Route = createFileRoute("/settings")({
	component: SettingsPage,
	validateSearch: Schema.toStandardSchemaV1(SettingsSearch),
})

function SettingsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const {
		visibleSections,
		visibleItems,
		isAdmin,
		canAccessDataPlatform,
		canAccessAi,
		isCustomerLoading,
		isLoading,
	} = useVisibleSettingsSections()

	// Pre-hub deep links: these tabs moved to the Integrations hub.
	if (search.tab === "connectors" || search.tab === "integrations") {
		return <Navigate to="/integrations" replace />
	}
	if (search.tab === "escalations" || search.tab === "ai") {
		return <Navigate to="/settings" search={{ tab: "automation" }} replace />
	}
	// "API Reference" is now the reference block at the foot of the API Keys page.
	if (search.tab === "developer") {
		return <Navigate to="/settings" search={{ tab: "api-keys" }} replace />
	}

	const activeTab = resolveActiveSettingsTab(search.tab, visibleItems)

	function handleTabSelect(tab: SettingsTab) {
		navigate({ search: { tab } })
	}

	// `data-platform` is the only tab whose visibility depends on the billing
	// customer, so deep-linking there while it loads would briefly show the first
	// tab before flipping. Hold the skeleton just for that case; every other tab
	// renders as soon as the session resolves.
	const waitingForGatedTab = search.tab === "data-platform" && isCustomerLoading

	const loading = isLoading || waitingForGatedTab
	const empty = !loading && visibleItems.length === 0

	// One shell for every state, so the sidebar reconciles in place as the session resolves.
	return (
		<DashboardPage
			breadcrumbs={
				loading || empty
					? [{ label: "Settings" }]
					: [{ label: "Settings", href: "/settings" }, { label: settingsTabLabels[activeTab] }]
			}
			filters={
				loading || empty ? undefined : (
					<SettingsNav
						sections={visibleSections}
						active={activeTab}
						onSelectTab={handleTabSelect}
					/>
				)
			}
		>
			{loading ? (
				<div className="space-y-3">
					<Skeleton className="h-8 w-56" />
					<Skeleton className="h-40 w-full" />
				</div>
			) : empty ? (
				<EmptyMessage>No settings are available for the current account.</EmptyMessage>
			) : (
				<>
					{activeTab === "organization" && <OrganizationSection />}
					{activeTab === "members" && <MembersSection />}
					{activeTab === "audit-log" && <AuditLogSection />}
					{activeTab === "setup-audit" && <SetupAuditSection />}
					{activeTab === "ingestion" && <IngestionSection />}
					{activeTab === "api-keys" && <ApiKeysSection />}
					{activeTab === "mcp" && <McpSection />}
					{activeTab === "notifications" && <NotificationsSection />}
					{activeTab === "automation" && (
						<AutomationSection isAdmin={isAdmin} hasEntitlement={canAccessAi} />
					)}
					{activeTab === "billing" && <BillingSection isAdmin={isAdmin} />}
					{activeTab === "data-platform" && (
						<OrgClickHouseSettingsSection
							isAdmin={isAdmin}
							hasEntitlement={canAccessDataPlatform}
						/>
					)}
				</>
			)}
		</DashboardPage>
	)
}
