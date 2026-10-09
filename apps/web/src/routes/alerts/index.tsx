import { createFileRoute, Link } from "@tanstack/react-router"
import { Schema } from "effect"

import { AlertsOverviewTab } from "@/components/alerts/overview/alerts-overview-tab"
import { AlertsSettingsTab, useDestinationManager } from "@/components/alerts/overview/settings-tab"
import { DestinationDialog } from "@/components/alerts/destination-dialog"
import { OpenDestinationDialogProvider } from "@/components/alerts/destination-manager-context"
import { DashboardPage } from "@/components/layout/dashboard-page"
import { PlusIcon } from "@/components/icons"
import { useAlertDestinationsList } from "@/hooks/use-alerts-list"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Button } from "@maple/ui/components/ui/button"
import { UnderlineTabStrip, underlineTabClass } from "@/components/common/underline-link-tabs"

type AlertsTab = "overview" | "settings"

// The URL value stays `settings` so existing links keep resolving.
const ALERTS_TABS: ReadonlyArray<{ value: AlertsTab; label: string }> = [
	{ value: "overview", label: "Overview" },
	{ value: "settings", label: "Destinations" },
]

const AlertsSearch = Schema.Struct({
	/**
	 * Accepts any string so legacy deep links (`tab=monitor`, `tab=rules`) keep
	 * resolving — anything that isn't "settings" lands on the overview.
	 */
	tab: Schema.optional(Schema.String),
	serviceName: Schema.optional(Schema.String),
	createdBy: Schema.optional(Schema.String),
	/** Health-summary filter over the rules list. */
	status: Schema.optional(Schema.Literals(["firing", "attention", "healthy", "disabled"])),
	/** Tag filter, shared by the incidents and rules lists. */
	tags: OptionalStringArrayParam,
	/** When set, the active list is grouped into per-tag sections. */
	groupByTag: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
})

export const Route = createFileRoute("/alerts/")({
	component: AlertsPage,
	validateSearch: Schema.toStandardSchemaV1(AlertsSearch),
})

function AlertsPage() {
	const search = Route.useSearch()

	const activeTab: AlertsTab = search.tab === "settings" ? "settings" : "overview"

	// Session + destinations back the header action only; the tabs own the rest
	// of their data (the atoms are shared, so this costs no extra requests).
	const sessionResult = useAtomValue(retainedQuery("auth", "session", {}))
	const { result: destinationsResult } = useAlertDestinationsList()
	const isAdmin = Result.builder(sessionResult)
		.onSuccess((session) => session.roles.some((role) => role === "root" || role === "org:admin"))
		.orElse(() => false)
	const hasDestinations = Result.builder(destinationsResult)
		.onSuccess((response) => response.destinations.length > 0)
		.orElse(() => false)

	const destinationManager = useDestinationManager()

	const tabBar = (
		<UnderlineTabStrip navigation label="Alerts sections">
			{ALERTS_TABS.map((tab) => (
				<Link
					key={tab.value}
					to="/alerts"
					search={(prev: Record<string, unknown>) => ({ ...prev, tab: tab.value })}
					aria-current={tab.value === activeTab ? "page" : undefined}
					className={underlineTabClass(tab.value === activeTab)}
				>
					{tab.label}
				</Link>
			))}
		</UnderlineTabStrip>
	)

	const headerActions =
		activeTab === "settings" ? (
			// Settings: the header owns the add action only once destinations exist.
			// While empty, the empty-state CTA is the single add affordance (avoids a duplicate).
			isAdmin && hasDestinations ? (
				<Button size="sm" onClick={() => destinationManager.openDialog()}>
					<PlusIcon size={14} />
					Add destination
				</Button>
			) : undefined
		) : (
			<Button
				size="sm"
				render={<Link to="/alerts/create" search={{ serviceName: search.serviceName }} />}
			>
				<PlusIcon size={14} />
				New rule
			</Button>
		)

	return (
		<OpenDestinationDialogProvider value={isAdmin ? () => destinationManager.openDialog() : null}>
			<DashboardPage breadcrumbs={[{ label: "Alerts" }]} headerActions={headerActions} tabs={tabBar}>
				{activeTab === "overview" ? (
					<AlertsOverviewTab />
				) : (
					<AlertsSettingsTab manager={destinationManager} isAdmin={isAdmin} />
				)}
			</DashboardPage>
			<DestinationDialog
				open={destinationManager.dialogOpen}
				onOpenChange={destinationManager.setDialogOpen}
				form={destinationManager.form}
				onFormChange={destinationManager.setForm}
				isEditing={destinationManager.isEditing}
				saving={destinationManager.saving}
				onSave={destinationManager.save}
			/>
		</OpenDestinationDialogProvider>
	)
}
