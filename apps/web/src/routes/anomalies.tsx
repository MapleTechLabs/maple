import { Fragment, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"

import { AiTriageCard } from "@/components/ai-triage/ai-triage-card"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatRelativeTime } from "@/lib/format"
import { Badge } from "@maple/ui/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { cn } from "@maple/ui/lib/utils"
import type { AnomalyIncidentDocument, AnomalySignalType } from "@maple/domain/http"

export const Route = effectRoute(createFileRoute("/anomalies"))({
	component: AnomaliesPage,
})

const SIGNAL_LABEL: Record<AnomalySignalType, string> = {
	error_rate: "Error rate",
	latency_p95: "p95 latency",
	throughput: "Throughput",
	error_spike: "Error spike",
	log_volume: "Log volume",
}

const formatValue = (incident: AnomalyIncidentDocument, value: number): string => {
	switch (incident.signalType) {
		case "error_rate":
			return `${(value * 100).toFixed(1)}%`
		case "latency_p95":
			return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(0)}ms`
		case "throughput":
		case "log_volume":
			return `${value.toFixed(1)}/min`
		case "error_spike":
			return `${Math.round(value)} in 30m`
	}
}

function AnomaliesPage() {
	const [statusFilter, setStatusFilter] = useState<"open" | "resolved" | "all">("open")
	const [expandedId, setExpandedId] = useState<string | null>(null)

	const incidentsQueryAtom = MapleApiAtomClient.query("anomalies", "listIncidents", {
		query: statusFilter === "all" ? {} : { status: statusFilter },
		reactivityKeys: ["anomalyIncidents", `anomalyIncidents:${statusFilter}`],
	})
	const incidentsResult = useAtomValue(incidentsQueryAtom)

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Anomalies" }]}
			title="Anomalies"
			description="Baseline deviations detected automatically across your services — no rules required."
			headerActions={
				<Tabs
					value={statusFilter}
					onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}
				>
					<TabsList>
						<TabsTrigger value="open">Open</TabsTrigger>
						<TabsTrigger value="resolved">Resolved</TabsTrigger>
						<TabsTrigger value="all">All</TabsTrigger>
					</TabsList>
				</Tabs>
			}
		>
			{Result.builder(incidentsResult)
				.onInitial(() => (
					<div className="space-y-3">
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-40 w-full" />
					</div>
				))
				.onError(() => (
					<Empty>
						<EmptyHeader>
							<EmptyTitle>Failed to load anomalies</EmptyTitle>
							<EmptyDescription>Try refreshing or check API logs.</EmptyDescription>
						</EmptyHeader>
					</Empty>
				))
				.onSuccess(({ incidents }) =>
					incidents.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>
									{statusFilter === "open" ? "No open anomalies" : "No anomalies"}
								</EmptyTitle>
								<EmptyDescription>
									The detector compares every service's error rate, latency, throughput, error
									fingerprints, and log volume against its own 7-day baseline. Incidents appear
									here when something deviates.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-8 p-0" aria-label="Severity accent" />
									<TableHead>Status</TableHead>
									<TableHead>Signal</TableHead>
									<TableHead>Service</TableHead>
									<TableHead>Environment</TableHead>
									<TableHead className="text-right">Observed</TableHead>
									<TableHead className="text-right">Baseline</TableHead>
									<TableHead className="text-right">Started</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{incidents.map((incident) => {
									const isOpen = incident.status === "open"
									const expanded = expandedId === incident.id
									return (
										<Fragment key={incident.id}>
											<TableRow
												className="cursor-pointer"
												onClick={() => setExpandedId(expanded ? null : incident.id)}
											>
												<TableCell className="w-8 p-0">
													<span
														aria-hidden
														className={cn(
															"block h-full w-[3px]",
															isOpen
																? incident.severity === "critical"
																	? "bg-destructive"
																	: "bg-amber-500"
																: "bg-border/60",
														)}
													/>
												</TableCell>
												<TableCell>
													<Badge
														variant="outline"
														className={cn(
															isOpen
																? incident.severity === "critical"
																	? "bg-destructive/10 text-destructive"
																	: "bg-amber-500/10 text-amber-600 dark:text-amber-400"
																: "bg-muted text-muted-foreground",
														)}
													>
														{isOpen ? incident.severity : (incident.resolveReason ?? "resolved")}
													</Badge>
												</TableCell>
												<TableCell className="font-medium">
													{SIGNAL_LABEL[incident.signalType]}
												</TableCell>
												<TableCell>
													{incident.errorIssueId !== null ? (
														<Link
															to="/errors/issues/$issueId"
															params={{ issueId: incident.errorIssueId }}
															className="text-foreground underline-offset-2 hover:underline"
															onClick={(event) => event.stopPropagation()}
														>
															{incident.serviceName}
														</Link>
													) : (
														incident.serviceName
													)}
												</TableCell>
												<TableCell className="text-muted-foreground">
													{incident.deploymentEnv || "—"}
												</TableCell>
												<TableCell className="text-right font-mono tabular-nums">
													{formatValue(incident, incident.lastObservedValue)}
												</TableCell>
												<TableCell className="text-right font-mono tabular-nums text-muted-foreground">
													{formatValue(incident, incident.baselineMedian)}
												</TableCell>
												<TableCell
													className="text-right tabular-nums text-muted-foreground"
													title={new Date(incident.firstTriggeredAt).toLocaleString()}
												>
													{formatRelativeTime(incident.firstTriggeredAt)}
												</TableCell>
											</TableRow>
											{expanded ? (
												<TableRow>
													<TableCell colSpan={8} className="bg-muted/30 p-4">
														<AiTriageCard incidentKind="anomaly" incidentId={incident.id} />
													</TableCell>
												</TableRow>
											) : null}
										</Fragment>
									)
								})}
							</TableBody>
						</Table>
					),
				)
				.render()}
		</DashboardLayout>
	)
}
