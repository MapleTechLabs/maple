import { useState } from "react"
import { Exit, Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { Link } from "@tanstack/react-router"
import { formatCost } from "@maple/agent-sessions"
import {
	VercelSettingsRequest,
	type VercelAiGatewayResponse,
	type VercelDrainStatus,
	type VercelInfraProject,
	type VercelInfraRequestBucket,
	type VercelIntegrationStatus,
	type VercelProjectStatus,
} from "@maple/domain/http"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Panel, PanelHeader } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { toastManager } from "@maple/ui/components/ui/toast"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { countLabel, formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { ColumnHead, DataTable, ROW_LINK_CLASS } from "@/components/common/data-table"
import { ErrorState } from "@/components/common/error-state"
import { RelativeTime } from "@/components/common/relative-time"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/common/stat-rail"
import { ArrowRightIcon, CircleWarningIcon, VercelIcon } from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { toastExit } from "@/lib/error-toast"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import {
	vercelAiGatewayResultAtom,
	vercelProjectsResultAtom,
	vercelRequestTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { VERCEL_ACCENT } from "./integration-catalog"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"
import { useIntegrationDisconnect } from "./use-integration-disconnect"
import { VercelConfigure, VercelCostNote, type VercelConfigureTarget } from "./vercel-configure"
import {
	deploymentStateLabel,
	deploymentTone,
	samplingLabel,
	scopeLabel,
	signalsLabel,
	vercelIssues,
	type VercelIssue,
} from "./vercel-model"
import { vercelStatusAtom } from "./vercel-status"

const REACTIVITY = ["vercelIntegrationStatus"]

/** Until the first sync lands, re-read often enough to see the drains and projects arrive. */
const SETTLING_REFRESH_MS = 15_000

/** The card's 24h window: no times, so the reads default to the last 24 hours and keep one key. */
const DAY = {} as const
const DAY_HOURLY = { bucketSeconds: 3600 } as const

const DRAIN_LABEL = {
	enabled: { label: "Enabled", tone: "ok" },
	disabled: { label: "Disabled", tone: "warn" },
	errored: { label: "Failing", tone: "crit" },
	missing: { label: "Deleted on Vercel", tone: "crit" },
	unknown: { label: "Not checked yet", tone: "neutral" },
} satisfies Record<VercelDrainStatus["status"], { label: string; tone: "ok" | "warn" | "crit" | "neutral" }>

/** The warehouse's last 24 hours for the card; `null` while loading. */
export interface VercelUsage {
	readonly projects: ReadonlyArray<VercelInfraProject> | null | "failed"
	readonly buckets: ReadonlyArray<VercelInfraRequestBucket> | null
	readonly gateway: VercelAiGatewayResponse | null
}

function useVercelUsage(): VercelUsage {
	const projectsResult = useAtomValue(vercelProjectsResultAtom({ data: DAY }))
	const timeseriesResult = useAtomValue(vercelRequestTimeseriesResultAtom({ data: DAY_HOURLY }))
	const gatewayResult = useAtomValue(vercelAiGatewayResultAtom({ data: DAY_HOURLY }))
	return {
		projects: Result.isSuccess(projectsResult)
			? projectsResult.value.projects
			: Result.isFailure(projectsResult)
				? "failed"
				: null,
		buckets: Result.isSuccess(timeseriesResult) ? timeseriesResult.value.buckets : null,
		gateway: Result.isSuccess(gatewayResult) ? gatewayResult.value : null,
	}
}

function useVercelReapply() {
	const save = useAtomSet(MapleInternalAtomClient.mutation("integrations", "vercelSettings"), {
		mode: "promiseExit",
	})
	return useAsyncAction(async () => {
		const result = await save({ payload: new VercelSettingsRequest({}), reactivityKeys: REACTIVITY })
		toastExit(result, { success: "Drains re-applied on Vercel", error: "Failed to re-apply the drains" })
	})
}

/** Sync, Configure and Disconnect, for the integration page header while connected. Admin-only. */
export function VercelHeaderActions() {
	const isAdmin = useIsOrgAdmin()
	const status = Option.getOrNull(AsyncResult.value(useAtomValue(vercelStatusAtom)))
	const sync = useAtomSet(MapleInternalAtomClient.mutation("integrations", "vercelSync"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleInternalAtomClient.mutation("integrations", "vercelDisconnect"), {
		mode: "promiseExit",
	})
	const [handleSync, syncing] = useAsyncAction(async () => {
		toastExit(await sync({ reactivityKeys: REACTIVITY }), { error: "Failed to sync Vercel" })
	})
	const { disconnect: handleDisconnect, pending: disconnecting } = useIntegrationDisconnect(
		async () => {
			const result = await disconnect({ reactivityKeys: REACTIVITY })
			if (Exit.isSuccess(result) && !result.value.drainsRemoved) {
				toastManager.add({
					type: "warning",
					title: "Remove the drains on Vercel",
					description:
						"Maple couldn't delete them. Delete Maple logs and Maple traces in the team's drain settings.",
				})
			}
			return result
		},
		{ success: "Vercel disconnected", error: "Failed to disconnect Vercel" },
	)
	const [target, setTarget] = useState<VercelConfigureTarget | null>(null)
	const [confirming, setConfirming] = useState(false)

	if (!isAdmin || status === null || !status.connected) return null
	const team = status.team?.name ?? "the team"

	return (
		<div className="flex items-center gap-2">
			<Button size="sm" variant="outline" onClick={() => void handleSync()} loading={syncing}>
				Sync now
			</Button>
			<Button size="sm" variant="outline" onClick={() => setTarget("configure")}>
				Configure
			</Button>
			<Button
				size="sm"
				variant="destructive-outline"
				onClick={() => setConfirming(true)}
				loading={disconnecting}
			>
				Disconnect
			</Button>
			{target === null ? null : (
				<VercelConfigure target={target} status={status} onClose={() => setTarget(null)} />
			)}
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Disconnect Vercel?"
				confirmLabel="Disconnect"
				onConfirm={handleDisconnect}
			>
				<dl className="flex flex-col gap-3 pb-3 text-sm">
					<div>
						<dt className="font-medium">On Vercel, right away</dt>
						<dd className="text-pretty text-muted-foreground">
							Deletes the <span className="font-mono text-foreground">Maple logs</span> and{" "}
							<span className="font-mono text-foreground">Maple traces</span> drains on {team}.
						</dd>
					</div>
					<div>
						<dt className="font-medium">In Maple</dt>
						<dd className="text-pretty text-muted-foreground">
							Removes the token. Logs and traces already in Maple stay until retention ends.
						</dd>
					</div>
				</dl>
			</ConfirmDialog>
		</div>
	)
}

function IssueAlert({
	issue,
	isAdmin,
	onToken,
}: {
	issue: VercelIssue
	isAdmin: boolean
	onToken: () => void
}) {
	const [reapply, reapplying] = useVercelReapply()
	return (
		<Alert variant={issue.tone}>
			<CircleWarningIcon />
			<AlertTitle>{issue.title}</AlertTitle>
			<AlertDescription>
				{issue.fix === "reapply" ? (
					<span>Re-applying the settings creates it again on Vercel.</span>
				) : (
					<span>{issue.detail}</span>
				)}
				{issue.fix === "reapply" && issue.detail !== null ? (
					<span className="font-mono text-2xs [overflow-wrap:anywhere]">
						Vercel: {issue.detail}
					</span>
				) : null}
			</AlertDescription>
			{isAdmin && issue.fix !== null ? (
				<AlertAction>
					{issue.fix === "token" ? (
						<Button size="sm" onClick={onToken}>
							Paste a new token
						</Button>
					) : (
						<Button
							size="sm"
							variant="outline"
							onClick={() => void reapply()}
							loading={reapplying}
						>
							Re-apply drains
						</Button>
					)}
				</AlertAction>
			) : null}
		</Alert>
	)
}

/** The 24h readout: traffic, failures and AI Gateway spend. */
function VercelQuickMetrics({ status, usage }: { status: VercelIntegrationStatus; usage: VercelUsage }) {
	// The band is a readout on top of the status: a failed read hides it rather than erroring.
	if (usage.projects === "failed") return null
	if (usage.projects === null) return <StatRailLoading count={3} columns={3} />

	const rows = usage.projects
	const { buckets, gateway } = usage
	const requests = rows.reduce((sum, row) => sum + row.requests, 0)
	const failed = rows.reduce((sum, row) => sum + row.requests5xx, 0)
	const errorLogs = rows.reduce((sum, row) => sum + row.errorLogs, 0)

	return (
		<StatRail columns={3}>
			<StatRailItem
				eyebrow="Requests · 24h"
				value={formatNumber(requests)}
				spark={buckets?.map((bucket) => bucket.requests)}
				sparkColor="var(--foreground)"
				subline={
					status.logsEnabled
						? `${countLabel(rows.length, "project")} sending logs`
						: "Logs are off. Turn them on in Configure."
				}
			/>
			<StatRailItem
				eyebrow="Server errors · 24h"
				value={formatNumber(failed)}
				tone={failed > 0 ? "crit" : undefined}
				spark={buckets?.map((bucket) => bucket.requests5xx)}
				subline={`${requests > 0 ? formatErrorRate(failed / requests) : "0%"} of requests · ${formatNumber(errorLogs)} error logs`}
			/>
			<StatRailItem
				eyebrow="AI Gateway · 24h"
				value={gateway === null ? "—" : formatCost(gateway.summary.costUsd)}
				spark={gateway?.timeseries.map((bucket) => bucket.costUsd)}
				sparkColor="var(--foreground)"
				subline={
					!status.tracesEnabled
						? "Traces are off. AI Gateway usage needs them."
						: gateway === null || gateway.summary.requests === 0
							? "No AI Gateway requests yet"
							: `${formatNumber(gateway.summary.requests)} requests · ${formatNumber(gateway.summary.inputTokens + gateway.summary.outputTokens)} tokens`
				}
				action={
					<Link
						to="/infra/vercel"
						className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
					>
						Open
						<ArrowRightIcon size={11} />
					</Link>
				}
			/>
		</StatRail>
	)
}

function ProductionCell({ project }: { project: VercelProjectStatus }) {
	const deployment = project.productionDeployment
	if (deployment === null) return <span className="text-muted-foreground">No production deploy</span>
	return (
		<span className="flex min-w-0 items-center gap-1.5">
			<StatusDot tone={deploymentTone(deployment.state)} />
			<span className="shrink-0">{deploymentStateLabel(deployment.state)}</span>
			<RelativeTime
				value={deployment.createdAt}
				variant="short"
				className="shrink-0 text-muted-foreground"
			/>
			{deployment.branch !== null ? (
				<TruncatedText text={deployment.branch} mono className="text-xs text-muted-foreground" />
			) : null}
		</span>
	)
}

function VercelProjects({
	status,
	usage,
}: {
	status: VercelIntegrationStatus
	usage: ReadonlyMap<string, VercelInfraProject> | null
}) {
	// Forwarded first, then by traffic: the projects Maple watches lead.
	const projects = status.projects.toSorted(
		(a, b) =>
			Number(b.forwarded) - Number(a.forwarded) ||
			(usage?.get(b.id)?.requests ?? 0) - (usage?.get(a.id)?.requests ?? 0) ||
			a.name.localeCompare(b.name),
	)
	return (
		<Panel className="min-w-0 flex-1 overflow-hidden">
			<PanelHeader title={`Projects (${status.projects.length})`} />
			<DataTable.Root ariaLabel="Vercel projects" className="border-y-0" maxHeight={420}>
				<DataTable.Head>
					<ColumnHead label="Project" width="w-0 min-w-44 flex-1" />
					<ColumnHead label="Production" width="w-64" hidden="hidden md:flex" />
					<ColumnHead label="Requests · 24h" width="w-28" align="right" />
					<ColumnHead label="5xx" width="w-16" align="right" />
				</DataTable.Head>
				{projects.length === 0 ? (
					<DataTable.Empty>
						Projects appear after the first sync, within a few minutes.
					</DataTable.Empty>
				) : (
					projects.map((project) => {
						const row = usage?.get(project.id)
						return (
							<Link
								key={project.id}
								to="/infra/vercel/$projectId"
								params={{ projectId: project.id }}
								className={cn(ROW_LINK_CLASS, "py-2.5 text-sm")}
							>
								<span className="flex w-0 min-w-44 flex-1 items-center gap-2">
									<TruncatedText text={project.name} className="font-medium" />
									{project.framework !== null ? (
										<Badge variant="meta" size="xs">
											{project.framework}
										</Badge>
									) : null}
									{project.forwarded ? null : (
										<Badge variant="outline" size="xs">
											Not forwarded
										</Badge>
									)}
								</span>
								<span className="hidden w-64 shrink-0 text-xs md:flex">
									<ProductionCell project={project} />
								</span>
								<span className="w-28 shrink-0 text-right tabular-nums">
									{usage === null ? (
										<Skeleton className="ml-auto h-4 w-12" />
									) : (
										formatNumber(row?.requests ?? 0)
									)}
								</span>
								<span
									className={cn(
										"w-16 shrink-0 text-right tabular-nums",
										(row?.requests5xx ?? 0) > 0
											? "text-severity-error"
											: "text-muted-foreground",
									)}
								>
									{usage === null ? "" : formatNumber(row?.requests5xx ?? 0)}
								</span>
							</Link>
						)
					})
				)}
			</DataTable.Root>
		</Panel>
	)
}

function DrainRow({
	name,
	enabled,
	drain,
}: {
	name: string
	enabled: boolean
	drain: VercelDrainStatus | null
}) {
	const state = !enabled
		? { label: "Off", tone: "neutral" as const }
		: drain === null
			? { label: "Missing", tone: "crit" as const }
			: DRAIN_LABEL[drain.status]
	return (
		<li className="flex items-center gap-3 px-4 py-2.5">
			<StatusDot tone={state.tone} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="font-mono text-xs text-foreground">{name}</span>
				{drain !== null && enabled ? (
					<TruncatedText text={drain.id} mono className="text-2xs text-muted-foreground" />
				) : null}
			</span>
			<span className="shrink-0 text-xs text-muted-foreground">{state.label}</span>
		</li>
	)
}

/** What Maple installed on the team, and what it forwards. */
function VercelDrains({ status }: { status: VercelIntegrationStatus }) {
	return (
		<div className="flex flex-col gap-4 lg:w-80 lg:shrink-0">
			<Panel className="overflow-hidden">
				<PanelHeader title="Drains on Vercel" />
				<ul className="divide-y divide-border/60 border-b border-border/60">
					<DrainRow name="Maple logs" enabled={status.logsEnabled} drain={status.drains.logs} />
					<DrainRow
						name="Maple traces"
						enabled={status.tracesEnabled}
						drain={status.drains.traces}
					/>
				</ul>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-xs">
					<dt className="text-muted-foreground">Team</dt>
					<dd className="truncate text-right">
						{status.team?.name}
						<span className="ml-1 font-mono text-muted-foreground">{status.team?.slug}</span>
					</dd>
					<dt className="text-muted-foreground">Sends</dt>
					<dd className="text-right">{signalsLabel(status)}</dd>
					<dt className="text-muted-foreground">Projects</dt>
					<dd className="text-right">{scopeLabel(status)}</dd>
					<dt className="text-muted-foreground">Sampling</dt>
					<dd className="text-right">{samplingLabel(status.samplingRate)}</dd>
					<dt className="text-muted-foreground">Checked</dt>
					<dd className="text-right">
						{status.lastSuccessAt === null ? (
							"Not yet"
						) : (
							<RelativeTime value={status.lastSuccessAt} />
						)}
					</dd>
				</dl>
			</Panel>
			<VercelCostNote />
		</div>
	)
}

/** The not-connected page: what Vercel brings, and the one way in. */
export function VercelNotConnected({ isAdmin, onConnect }: { isAdmin: boolean; onConnect: () => void }) {
	return (
		<IntegrationEmpty icon={VercelIcon} accent={VERCEL_ACCENT} iconClassName="text-foreground">
			<IntegrationEmptyFeatures>
				<IntegrationEmptyFeature
					label="Requests"
					title="Traffic, errors and cache"
					description="Every request, function and edge log, with status, path and cache result per project."
				/>
				<IntegrationEmptyFeature
					label="AI Gateway"
					title="Spend by model and project"
					description="Each gateway request with its model, tokens, cost and latency, also in Agent Sessions."
				/>
				<IntegrationEmptyFeature
					label="Deployments"
					title="Next to your traces"
					description="Production deployments per project, and deployment traces from @vercel/otel."
				/>
			</IntegrationEmptyFeatures>
			<IntegrationEmptyCard>
				<IntegrationEmptyMedia />
				{isAdmin ? (
					<>
						<IntegrationEmptyHint>
							Paste a Vercel token. Maple creates a logs drain and a traces drain on the team
							you pick.
						</IntegrationEmptyHint>
						<Button onClick={onConnect}>
							<VercelIcon />
							Connect Vercel
						</Button>
						<IntegrationEmptyFooter>
							Needs Vercel Pro or Enterprise · Vercel bills drains by volume · sampling lowers
							it
						</IntegrationEmptyFooter>
					</>
				) : (
					<IntegrationEmptyHint>
						A Maple organization admin connects Vercel with a team token.
					</IntegrationEmptyHint>
				)}
			</IntegrationEmptyCard>
		</IntegrationEmpty>
	)
}

/** A connected team: what needs fixing, the last 24 hours, the projects and the drains. */
export function VercelConnectedView({
	status,
	usage,
	isAdmin,
	onToken,
}: {
	status: VercelIntegrationStatus
	usage: VercelUsage
	isAdmin: boolean
	onToken: () => void
}) {
	const byProject = Array.isArray(usage.projects)
		? new Map(usage.projects.map((row) => [row.projectId, row]))
		: null
	return (
		<div className="flex flex-col gap-4">
			{vercelIssues(status).map((issue) => (
				<IssueAlert key={issue.key} issue={issue} isAdmin={isAdmin} onToken={onToken} />
			))}
			<VercelQuickMetrics status={status} usage={usage} />
			<div className="flex flex-col gap-4 lg:flex-row lg:items-start">
				<VercelProjects status={status} usage={byProject} />
				<VercelDrains status={status} />
			</div>
			{isAdmin ? null : (
				<p className="text-xs text-muted-foreground">
					Only Maple organization admins can configure or disconnect Vercel.
				</p>
			)}
		</div>
	)
}

/**
 * The Vercel integration page. An admin pastes a token, picks the team and what to forward, and
 * Maple creates the drains on Vercel. The page shows the drains, the projects with their
 * production deployment, and the last 24 hours. Everything that changes the drains is in Configure.
 */
export function VercelIntegrationCard() {
	const statusResult = useAtomValue(vercelStatusAtom)
	const refreshStatus = useAtomRefresh(vercelStatusAtom)
	const isAdmin = useIsOrgAdmin()
	const [target, setTarget] = useState<VercelConfigureTarget | null>(null)

	// Keep the last loaded status if a refetch fails.
	const status = Option.getOrNull(AsyncResult.value(statusResult))
	const settling = status?.connected === true && !status.authFailed && status.lastSuccessAt === null
	useIntervalRefresh(refreshStatus, { intervalMs: SETTLING_REFRESH_MS, enabled: settling })

	if (Result.isInitial(statusResult) && status === null) {
		return <Skeleton className="h-40 w-full rounded-md" />
	}
	if (Result.isFailure(statusResult) && status === null) {
		return (
			<ErrorState
				error={statusResult.cause}
				title="Failed to load the Vercel integration"
				onRetry={refreshStatus}
			/>
		)
	}

	const configure =
		target === null ? null : (
			<VercelConfigure target={target} status={status} onClose={() => setTarget(null)} />
		)

	return (
		<>
			{status === null || !status.connected ? (
				<VercelNotConnected isAdmin={isAdmin} onConnect={() => setTarget("connect")} />
			) : (
				<VercelConnectedCard status={status} isAdmin={isAdmin} onToken={() => setTarget("token")} />
			)}
			{configure}
		</>
	)
}

/** Reads the warehouse only once connected. */
function VercelConnectedCard({
	status,
	isAdmin,
	onToken,
}: {
	status: VercelIntegrationStatus
	isAdmin: boolean
	onToken: () => void
}) {
	return (
		<VercelConnectedView status={status} usage={useVercelUsage()} isAdmin={isAdmin} onToken={onToken} />
	)
}
