import { createFileRoute, Link } from "@tanstack/react-router"
import { Schema } from "effect"

import { AlertsHub, AlertsTabCountsBoundary } from "@/components/alerts/overview/alerts-hub"
import { AlertsRoutingTab, useDestinationManager } from "@/components/alerts/overview/routing-tab"
import { DestinationDialog } from "@/components/alerts/destination-dialog"
import { OpenDestinationDialogProvider } from "@/components/alerts/destination-manager-context"
import { DashboardPage } from "@/components/layout/dashboard-page"
import { PlusIcon } from "@/components/icons"
import { useAlertDestinationsList } from "@/hooks/use-alerts-list"
import type { RuleBucket } from "@/lib/alerts/overview-derive"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { UnderlineTabStrip, underlineTabClass } from "@/components/common/underline-link-tabs"

type AlertsTab = "inbox" | "rules" | "routing"

const ALERTS_TABS: ReadonlyArray<{ value: AlertsTab; label: string }> = [
	{ value: "inbox", label: "Inbox" },
	{ value: "rules", label: "Rules" },
	{ value: "routing", label: "Routing" },
]

/** Legacy `tab` values map onto the current tabs so old links keep resolving. */
const resolveTab = (tab: string | undefined): AlertsTab => {
	switch (tab) {
		case "rules":
			return "rules"
		case "routing":
		case "settings":
			return "routing"
		default:
			return "inbox"
	}
}

/** `attention` is the legacy name of the blind bucket. */
const resolveStatus = (status: string | undefined): RuleBucket | undefined => {
	switch (status) {
		case "firing":
		case "blind":
		case "healthy":
		case "disabled":
			return status
		case "attention":
			return "blind"
		default:
			return undefined
	}
}

const AlertsSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
	serviceName: Schema.optional(Schema.String),
	/** Rules tab status filter. */
	status: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/alerts/")({
	component: AlertsPage,
	validateSearch: Schema.toStandardSchemaV1(AlertsSearch),
})

function AlertsPage() {
	const search = Route.useSearch()

	const activeTab = resolveTab(search.tab)
	const navigate = Route.useNavigate()

	// Session gates the header actions; destinations feed the hub. The tabs own the rest
	// of their data (the atoms are shared, so this costs no extra requests).
	const sessionResult = useAtomValue(retainedQuery("auth", "session", {}))
	const { result: destinationsResult } = useAlertDestinationsList()
	const isAdmin = Result.builder(sessionResult)
		.onSuccess((session) => session.roles.some((role) => role === "root" || role === "org:admin"))
		.orElse(() => false)
	const destinations = Result.builder(destinationsResult)
		.onSuccess((response) => response.destinations)
		.orElse(() => [])

	const destinationManager = useDestinationManager()

	const tabBar = (
		<AlertsTabCountsBoundary>
			{(counts) => (
				<UnderlineTabStrip navigation label="Alerts sections">
					{ALERTS_TABS.map((tab) => {
						const count =
							tab.value === "inbox"
								? counts?.open
								: tab.value === "rules"
									? counts?.rules
									: undefined
						return (
							<Link
								key={tab.value}
								to="/alerts"
								search={(prev: Record<string, unknown>) => ({ ...prev, tab: tab.value })}
								aria-current={tab.value === activeTab ? "page" : undefined}
								className={underlineTabClass(tab.value === activeTab)}
							>
								{tab.label}
								{count !== undefined && count > 0 && (
									<span
										className={cn(
											"font-mono text-xs tabular-nums",
											tab.value === "inbox"
												? "text-severity-error"
												: "text-muted-foreground",
										)}
									>
										{count}
									</span>
								)}
							</Link>
						)
					})}
				</UnderlineTabStrip>
			)}
		</AlertsTabCountsBoundary>
	)

	// Both actions on every tab: creating a destination is admin-only server side.
	const headerActions = (
		<div className="flex items-center gap-2">
			{isAdmin && (
				<Button size="sm" variant="outline" onClick={() => destinationManager.openDialog()}>
					<PlusIcon />
					New destination
				</Button>
			)}
			<Button
				size="sm"
				render={<Link to="/alerts/create" search={{ serviceName: search.serviceName }} />}
			>
				<PlusIcon />
				New rule
			</Button>
		</div>
	)

	return (
		<OpenDestinationDialogProvider value={isAdmin ? () => destinationManager.openDialog() : null}>
			<DashboardPage breadcrumbs={[{ label: "Alerts" }]} headerActions={headerActions} tabs={tabBar}>
				{activeTab === "routing" ? (
					<AlertsRoutingTab manager={destinationManager} isAdmin={isAdmin} />
				) : (
					<AlertsHub
						tab={activeTab}
						destinations={destinations}
						isAdmin={isAdmin}
						serviceName={search.serviceName}
						status={resolveStatus(search.status)}
						onStatusChange={(status) => navigate({ search: (prev) => ({ ...prev, status }) })}
					/>
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
