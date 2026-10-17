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
import { ModelProviderSection } from "@/components/settings/ai-provider-section"
import { AutoTriageSection } from "@/components/settings/ai-triage-settings-section"
import { AiEscalationCard } from "@/components/settings/ai-escalation-card"
import { SettingsSections } from "@/components/settings/settings-section"
import { AutomationSection } from "@/components/settings/automation-section"
import { OrgClickHouseSettingsSection } from "@/components/settings/org-clickhouse-settings-section"
import { GeneralSection } from "@/components/settings/general-section"
import { SetupAuditSection } from "@/components/settings/setup-audit-section"
import { AuditLogSearchFields, pickAuditLogSearch } from "@/components/settings/audit-log-filters"
import {
	legacySettingsTabValues,
	resolveActiveSettingsTab,
	resolveLegacySettingsTab,
	SettingsNav,
	settingsTabLabels,
	settingsTabValues,
	useVisibleSettingsSections,
	type SettingsTab,
} from "@/components/settings/settings-nav"

const SettingsSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals([...settingsTabValues, ...legacySettingsTabValues])),
	// Stripe Checkout return marker — see `lib/billing/checkout-return.ts`.
	checkout: Schema.optional(Schema.Literal("complete")),
	...AuditLogSearchFields,
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

	// Retired tab ids keep old deep links (emails, docs, bookmarks) working.
	const legacy = resolveLegacySettingsTab(search.tab)
	if (legacy?.kind === "integrations") return <Navigate to="/integrations" replace />
	if (legacy?.kind === "account") return <Navigate to="/account" search={{ tab: legacy.tab }} replace />
	if (legacy?.kind === "tab") {
		return <Navigate to="/settings" search={{ tab: legacy.tab }} replace />
	}

	const activeTab = resolveActiveSettingsTab(search.tab, visibleItems)

	function handleTabSelect(tab: SettingsTab) {
		// Audit log filters ride along, so leaving the tab and coming back keeps them.
		void navigate({ search: { tab, ...pickAuditLogSearch(search) } })
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
					{activeTab === "general" && <GeneralSection />}
					{activeTab === "members" && <MembersSection />}
					{activeTab === "audit-log" && <AuditLogSection />}
					{activeTab === "setup-health" && <SetupAuditSection />}
					{activeTab === "ingestion" && <IngestionSection />}
					{activeTab === "keys" && <ApiKeysSection />}
					{activeTab === "mcp" && <McpSection />}
					{activeTab === "ai" && (
						<SettingsSections>
							<ModelProviderSection />
							{/* The tab is admin-only; orgs outside the auto-triage rollout see a preview. */}
							<AutoTriageSection available={canAccessAi} />
							<AiEscalationCard />
						</SettingsSections>
					)}
					{activeTab === "automation" && <AutomationSection isAdmin={isAdmin} />}
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
