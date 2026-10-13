import * as React from "react"
import { Effect, Exit } from "effect"
import { useNavigate } from "@tanstack/react-router"

import { countLabel } from "@maple/ui/lib/format"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { defaultWidgetLayout } from "@maple/domain/http"
import { BellIcon, GridSquareCirclePlusIcon, LinkIcon } from "@/components/icons"
import { useDashboardStore } from "@/hooks/use-dashboard-store"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { ErrorState } from "@/components/common/error-state"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { encodeAlertChartToSearchParam } from "@/lib/alerts/widget-chart-param"
import type { WidgetDataSource } from "@/components/dashboard-builder/types"
import type { MetricsQueryDraft } from "@maple/query-engine/query-builder"
import { makeQueryDataSource } from "@maple/widgets/dashboard"

function buildWidgetDataSource(draft: MetricsQueryDraft): WidgetDataSource {
	return makeQueryDataSource({
		resultShape: "timeseries",
		// A fresh query id: the explorer's stable atom-key id must not leak into
		// persisted widgets, where two adds would otherwise share one id.
		queries: [{ ...draft, id: crypto.randomUUID() }],
	})
}

interface MetricGraduationActionsProps {
	draft: MetricsQueryDraft
}

/**
 * The explorer is scratch space — these actions graduate the current query
 * into something durable: a dashboard widget, an alert rule, or a shared link.
 */
export function MetricGraduationActions({ draft }: MetricGraduationActionsProps) {
	const navigate = useNavigate()
	const [dialogOpen, setDialogOpen] = React.useState(false)

	const handleCreateAlert = () => {
		const chart = encodeAlertChartToSearchParam({
			dashboardId: "metrics-explorer",
			widget: {
				id: crypto.randomUUID(),
				visualization: "chart",
				dataSource: buildWidgetDataSource(draft),
				display: { title: draft.metricName },
			},
		})
		void navigate({ to: "/alerts/create", search: chart ? { chart } : {} })
	}

	return (
		<div className="flex items-center gap-2">
			<Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
				<GridSquareCirclePlusIcon />
				Add to dashboard
			</Button>
			<Button variant="outline" size="sm" onClick={handleCreateAlert}>
				<BellIcon />
				Create alert
			</Button>
			<CopyButton
				value={() => window.location.href}
				label="Link"
				idleLabel="Copy link"
				idleIcon={LinkIcon}
				toast={false}
				variant="outline"
			/>

			<AddToDashboardDialog open={dialogOpen} onOpenChange={setDialogOpen} draft={draft} />
		</div>
	)
}

function AddToDashboardDialog({
	open,
	onOpenChange,
	draft,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	draft: MetricsQueryDraft
}) {
	const navigate = useNavigate()
	const { dashboards, readOnly, addWidget, importDashboard } = useDashboardStore()
	const [newName, setNewName] = React.useState("")
	const [error, setError] = React.useState<{ readonly title: string; readonly cause: unknown } | null>(null)

	const widgetDisplay = { title: draft.metricName, chartId: "query-builder-area" }

	const addToDashboard = (dashboardId: string) => {
		const exit = Effect.runSyncExit(
			Effect.try(() => addWidget(dashboardId, "chart", buildWidgetDataSource(draft), widgetDisplay)),
		)
		if (Exit.isFailure(exit)) {
			setError({ title: "Failed to add widget", cause: exit })
			return
		}
		onOpenChange(false)
		void navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
		})
	}

	/**
	 * Creates the dashboard WITH the widget in one call rather than creating it
	 * and then adding to it. The widget mutators write through the Electric
	 * collection, and a dashboard created a moment ago may not have synced into it
	 * yet — that gap used to swallow the widget, leaving a brand-new empty
	 * dashboard and no explanation.
	 */
	const [createDashboard, creating] = useAsyncAction(async (name: string) => {
		setError(null)
		const exit = await Effect.runPromiseExit(
			Effect.tryPromise(() =>
				importDashboard({
					name,
					timeRange: { type: "relative", value: "12h" },
					widgets: [
						{
							id: crypto.randomUUID(),
							visualization: "chart",
							dataSource: buildWidgetDataSource(draft),
							display: widgetDisplay,
							layout: { x: 0, y: 0, ...defaultWidgetLayout("chart") },
						},
					],
				}),
			),
		)
		if (Exit.isFailure(exit)) {
			setError({ title: "Failed to create dashboard", cause: exit })
			return
		}
		onOpenChange(false)
		void navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId: exit.value.id },
		})
	})

	const handleCreate = async () => {
		const name = newName.trim()
		if (!name || creating) return
		await createDashboard(name)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add to dashboard</DialogTitle>
					<DialogDescription>
						Adds the current query for <span className="font-mono">{draft.metricName}</span> as a
						chart widget.
					</DialogDescription>
				</DialogHeader>

				{readOnly ? (
					<p className="text-sm text-muted-foreground">Dashboards are read-only for your role.</p>
				) : (
					<div className="space-y-4">
						{dashboards.length > 0 && (
							<div className="max-h-64 space-y-1 overflow-y-auto">
								{dashboards.map((dashboard) => (
									<button
										key={dashboard.id}
										type="button"
										onClick={() => addToDashboard(dashboard.id)}
										className="flex w-full items-center justify-between gap-2 rounded-sm border px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
									>
										<span className="truncate">{dashboard.name}</span>
										<span className="shrink-0 text-xs text-muted-foreground">
											{countLabel(dashboard.widgets.length, "widget")}
										</span>
									</button>
								))}
							</div>
						)}

						<div className="flex items-center gap-2">
							<Input
								value={newName}
								onChange={(event) => setNewName(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") void handleCreate()
								}}
								placeholder="New dashboard name..."
								className="h-8 flex-1 text-sm"
							/>
							<Button
								size="sm"
								onClick={() => void handleCreate()}
								disabled={!newName.trim()}
								loading={creating}
							>
								Create & add
							</Button>
						</div>

						{error && (
							<ErrorState
								error={error.cause}
								title={error.title}
								variant="inline"
								className="py-0"
							/>
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}
