import { Fragment, useState } from "react"
import type React from "react"
import { Link } from "@tanstack/react-router"
import { Exit, Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { DropdownMenuItem, DropdownMenuSeparator } from "@maple/ui/components/ui/dropdown-menu"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Panel } from "@maple/ui/components/ui/panel"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { countLabel } from "@maple/ui/lib/format"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import {
	removedGcpConnectorsAtomFamily,
	type RemovedGcpConnector,
} from "@/atoms/gcp-removed-connectors-atoms"
import { ErrorState } from "@/components/common/error-state"
import { RelativeTime } from "@/components/common/relative-time"
import { SectionHeading } from "@/components/common/section-heading"
import { ArrowRightIcon, GoogleCloudIcon, GoogleCloudMonoIcon } from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { useLiveClock } from "@/hooks/use-live-clock"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { Result, useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { showErrorToast } from "@/lib/error-toast"
import { encodeLogAttributeFilter } from "@/lib/logs/log-attribute-filters"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { getActiveOrgId } from "@/lib/services/common/auth-headers"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	GCP_LINK,
	GCP_REACTIVITY_KEYS,
	GCP_SETTLING_REFRESH_MS,
	GCP_TITLE,
	GcpCommand,
	GcpConfigure,
	GcpCopyScriptButton,
	GcpDisconnectDialog,
	GcpExternalLink,
	GcpOpenCloudShellButton,
	type GcpConfigureTarget,
} from "./gcp-configure"
import {
	GCP_CONNECTION_LABEL,
	GCP_LOG_STATUS,
	GCP_METRICS_STATUS,
	GCP_SCOPE_NAMES,
	GCP_STATE_ORDER,
	gcpConnectionState,
	gcpLogState,
	gcpMessageParts,
	gcpMetricsState,
	gcpPendingChanges,
	gcpRunAsked,
	gcpScopeLabel,
	gcpScriptNeeded,
	gcpSetupRunning,
	gcpWorstState,
	type GcpCapability,
} from "./gcp-connector-state"
import { GCP_ACCENT, HEALTH_TONE, gcpStatusQuery } from "./integration-catalog"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"

/** Keeps the "last log" and "last read" times and a new error current on a page left open. */
const STEADY_REFRESH_MS = 60_000

/** How the plan-limit texts name the billing page. */
const BILLING_PAGE = "Settings, Billing"
// An address ends before the punctuation or the bracket that follows it.
const LINK_PATTERN = new RegExp(`(https://[^\\s)]*[^\\s).,]|${BILLING_PAGE})`)

/** A sentence of a failure: an address in it becomes a named link, the billing page a link to it. */
function Linked({ text }: { text: string }) {
	return text.split(LINK_PATTERN).map((part, index) =>
		index % 2 === 0 ? (
			part
		) : part === BILLING_PAGE ? (
			<Link key={index} to="/settings" search={{ tab: "billing" }} className={GCP_LINK}>
				{part}
			</Link>
		) : (
			<GcpExternalLink key={index} href={part}>
				{part.startsWith("https://console.cloud.google.com/") ? "Google Cloud console" : part}
			</GcpExternalLink>
		),
	)
}

/**
 * A failure in the API's own words, laid out to be scanned: its first sentence as the headline,
 * what to do under it, and what Google answered as code.
 */
export function GcpMessage({ text }: { text: string }) {
	const { headline, body, answer } = gcpMessageParts(text)
	return (
		<div role="note" className="flex flex-col gap-1.5 [overflow-wrap:anywhere]">
			<p className="font-semibold text-pretty text-foreground">
				<Linked text={headline} />
			</p>
			{body.length === 0 ? null : (
				<p className="text-pretty text-muted-foreground">
					{body.map((sentence, index) => (
						<Fragment key={index}>
							{index === 0 ? null : " "}
							<Linked text={sentence} />
						</Fragment>
					))}
				</p>
			)}
			{answer === null ? null : (
				<InlineCode className="block rounded-md px-2.5 py-1.5">{answer}</InlineCode>
			)}
		</div>
	)
}

const ASK_ADMIN = "Ask a Maple organization admin to run the setup script."

/** The card's one filled button, which runs the script; for everyone but admins, the sentence asking for it. */
function RunScript({ label, onRun }: { label: string; onRun: (() => void) | null }) {
	return onRun === null ? (
		<p className="text-xs text-foreground/80">{ASK_ADMIN}</p>
	) : (
		<Button size="sm" onClick={onRun}>
			{label}
		</Button>
	)
}

const RETRIES = "Maple retries every 5 minutes. If this lasts an hour, write to support@maple.dev."

/** Something to know or do about a connection: a sentence for a headline, what it means, the one thing to do. */
interface Issue {
	readonly key: string
	readonly tone: "crit" | "warn" | "live"
	readonly title: string
	readonly body?: React.ReactNode
	readonly action?: React.ReactNode
}

function IssueNote({ issue }: { issue: Issue }) {
	return (
		<div role={issue.tone === "live" ? "note" : "status"} className="flex gap-2.5">
			{/* As wide as the row's dot lane, so the headline lines up with the connection's name. */}
			<span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
				<StatusDot tone={issue.tone} size="lg" />
			</span>
			<div className="flex min-w-0 flex-col gap-1.5">
				<p className="text-sm font-medium text-pretty">{issue.title}</p>
				{issue.body === undefined ? null : (
					<div className="max-w-2xl text-xs/[18px] text-pretty text-muted-foreground">{issue.body}</div>
				)}
				{issue.action === undefined ? null : <div className="flex pt-1">{issue.action}</div>}
			</div>
		</div>
	)
}

type LogState = ReturnType<typeof gcpLogState>
type MetricsState = ReturnType<typeof gcpMetricsState>

/**
 * What a connection needs said about it, worst first; empty when it is healthy. The card has one
 * filled button: the script being due takes it, else the first failure another run repairs.
 */
function connectionIssues({
	connector,
	log,
	metrics,
	nowMs,
	onRunScript,
}: {
	connector: V2GcpConnector
	log: LogState
	metrics: MetricsState
	nowMs: number
	onRunScript: (() => void) | null
}): ReadonlyArray<Issue> {
	const needed = gcpScriptNeeded(connector, nowMs)
	const repairs = needed === null ? gcpRunAsked(connector, nowMs)[0] : undefined
	const rerun = (capability: GcpCapability) =>
		repairs === capability ? <RunScript label="Run the script again" onRun={onRunScript} /> : undefined
	const cleanedUp = connector.applied_logs_enabled === false && connector.applied_metrics_enabled === false
	const issues: Array<Issue> = []

	if (log.kind === "failing") {
		issues.push({
			key: "logs-failing",
			tone: "crit",
			title: "Log forwarding is failing",
			body: <GcpMessage text={log.error} />,
			action: rerun("logs"),
		})
	}
	if (metrics.kind === "failing") {
		issues.push({
			key: "metrics-failing",
			tone: "crit",
			title: "Key metrics can't be read",
			body: <GcpMessage text={metrics.error} />,
			action: rerun("metrics"),
		})
	}
	if (needed !== null) {
		const lines =
			needed === "setup-pending"
				? [
						connector.setup_reported_at === null
							? "Google Cloud has nothing of Maple's yet. Running the setup script takes about a minute."
							: "The last run stopped part of the way. Run the script again: it continues where it stopped.",
					]
				: gcpPendingChanges(connector, nowMs)
		issues.push({
			key: "script",
			tone: "warn",
			title: needed === "setup-pending" ? "Setup pending" : "Changes not applied in Google Cloud",
			body: (
				<>
					{lines.length === 1 ? (
						<p>{lines[0]}</p>
					) : (
						<ul className="list-disc pl-4">
							{lines.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					)}
					{onRunScript !== null && needed === "changes-pending" && cleanedUp ? (
						<p>To remove the connection instead, choose Disconnect in its menu.</p>
					) : null}
				</>
			),
			action: (
				<RunScript
					label={needed === "setup-pending" ? "Finish setup" : "Apply changes"}
					onRun={onRunScript}
				/>
			),
		})
	}
	if (metrics.kind === "incomplete") {
		issues.push({
			key: "metrics-incomplete",
			tone: "warn",
			title: "Key metrics are incomplete",
			body: <GcpMessage text={metrics.error} />,
			action: rerun("metrics"),
		})
	}
	if (metrics.kind === "stalled") {
		issues.push({ key: "metrics-stalled", tone: "warn", title: "No metrics in 30 minutes", body: RETRIES })
	}
	if (log.kind === "waiting" && log.overdue) {
		issues.push({
			key: "logs-overdue",
			tone: "warn",
			title: "No log entry in 20 minutes",
			body: "Nothing that passes the filter was logged, or the sink can't publish. Write a test entry. If it isn't here within a minute, run the setup script again.",
			action: (
				<GcpCommand>
					{`gcloud logging write maple-test "hello from Maple" --project=${connector.project_id}`}
				</GcpCommand>
			),
		})
	}
	if (metrics.kind === "waiting" && metrics.overdue) {
		issues.push({ key: "metrics-overdue", tone: "warn", title: "No metrics have arrived yet", body: RETRIES })
	}
	if (metrics.kind === "receiving" && metrics.resourcesError !== null) {
		issues.push({
			key: "resources",
			tone: "warn",
			title: "Resource list incomplete",
			body: <GcpMessage text={metrics.resourcesError} />,
		})
	}
	if (issues.length > 0) return issues

	// Nothing wrong yet: what the connection is waiting for.
	if (gcpSetupRunning(connector, nowMs)) {
		return [
			{
				key: "running",
				tone: "live",
				title: "The setup script is still running",
				body: "Logs and metrics start once it has finished.",
			},
		]
	}
	if (log.kind === "waiting" || metrics.kind === "waiting") {
		return [
			{
				key: "waiting",
				tone: "live",
				title: "Waiting for the first data",
				body:
					log.kind === "waiting"
						? "Google Cloud usually starts sending within 10 minutes. Logs written before then aren't forwarded."
						: "The first metrics arrive within about 10 minutes.",
			},
		]
	}
	return []
}

/** A capability's state in a word or two, with when it last delivered. */
function signalText(
	capability: GcpCapability,
	log: LogState,
	metrics: MetricsState,
): { readonly tone: Tone; readonly text: React.ReactNode } {
	if (capability === "logs") {
		switch (log.kind) {
			case "off":
				return { tone: "neutral", text: "Off" }
			case "failing":
				return {
					tone: "crit",
					text:
						log.lastLogReceivedAt === null ? (
							"Rejected"
						) : (
							<RelativeTime value={log.lastLogReceivedAt} prefix="Rejected · last entry" />
						),
				}
			case "setup-pending":
			case "setup-running":
				return { tone: "neutral", text: GCP_LOG_STATUS[log.kind].label }
			case "waiting":
				return log.overdue
					? { tone: "warn", text: "No entries in 20 minutes" }
					: { tone: "neutral", text: "No entries yet" }
			case "idle":
				return {
					tone: "neutral",
					text: <RelativeTime value={log.lastLogReceivedAt} prefix="Nothing in 24 hours · last entry" />,
				}
			case "receiving":
				return { tone: "ok", text: <RelativeTime value={log.lastLogReceivedAt} prefix="Last entry" /> }
		}
	}
	switch (metrics.kind) {
		case "off":
			return { tone: "neutral", text: "Off" }
		case "setup-pending":
		case "setup-running":
			return { tone: "neutral", text: GCP_METRICS_STATUS[metrics.kind].label }
		case "waiting":
			return { tone: metrics.overdue ? "warn" : "neutral", text: "No reads yet" }
		case "failing":
			return {
				tone: "crit",
				text:
					metrics.lastMetricsReceivedAt === null ? (
						"Can't be read"
					) : (
						<RelativeTime value={metrics.lastMetricsReceivedAt} prefix="Can't be read · last read" />
					),
			}
		case "incomplete":
		case "stalled":
			return {
				tone: "warn",
				text: (
					<RelativeTime
						value={metrics.lastMetricsReceivedAt}
						prefix={`${GCP_METRICS_STATUS[metrics.kind].label} · last read`}
					/>
				),
			}
		case "receiving":
			return { tone: "ok", text: <RelativeTime value={metrics.lastMetricsReceivedAt} prefix="Last read" /> }
	}
}

const SIGNAL_LINK = "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"

/** The logs this connection forwarded: ingest stamps each with the connection's id. */
const logsSearch = (connector: V2GcpConnector) => ({
	attrs: [
		encodeLogAttributeFilter({
			source: "resource",
			key: "maple_gcp_connector_id",
			value: connector.id,
			negated: false,
		}),
	],
})

/** One capability in an expanded card: its name, its state, and where its data shows up once it does. */
function Signal({
	name,
	signal,
	link,
}: {
	name: string
	signal: { readonly tone: Tone; readonly text: React.ReactNode }
	link?: React.ReactNode
}) {
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3">
			<span className="text-xs font-medium">{name}</span>
			<span className={cn("text-xs/[18px]", TONE_TEXT[signal.tone])}>{signal.text}</span>
			{link === undefined ? null : <div className="pt-1">{link}</div>}
		</div>
	)
}

/** A column of the compact row: a label over a time. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex w-36 shrink-0 flex-col gap-0.5">
			<span className="text-2xs text-muted-foreground">{label}</span>
			<span className="truncate text-xs">{children}</span>
		</div>
	)
}

export function GcpConnection({
	connector,
	isAdmin,
	nowMs,
	onConfigure,
	onRemoved,
}: {
	connector: V2GcpConnector
	isAdmin: boolean
	nowMs: number
	onConfigure: (stage: "choose" | "apply") => void
	onRemoved: (removed: RemovedGcpConnector) => void
}) {
	const remove = useAtomSet(MapleApiV2AtomClient.mutation("gcpIntegration", "deleteConnector"), {
		mode: "promiseExit",
	})
	const label = gcpScopeLabel(connector)
	// No run has reported: as far as Maple knows, nothing exists in Google Cloud.
	const neverReported =
		connector.applied_logs_enabled === null && connector.applied_metrics_enabled === null
	const cleanedUp = connector.applied_logs_enabled === false && connector.applied_metrics_enabled === false
	const [disconnectOpen, setDisconnectOpen] = useState(false)

	// Resolving to `false` keeps the dialog open for a retry.
	const [disconnect, disconnecting] = useAsyncAction(async () => {
		const result = await remove({ params: { id: connector.id }, reactivityKeys: GCP_REACTIVITY_KEYS })
		if (Exit.isFailure(result)) {
			showErrorToast(result, { title: "Failed to disconnect" })
			return false
		}
		// Kept unless the cleanup script was seen to run. A script that stopped part of the way, or
		// could not reach Maple, leaves resources behind without a report.
		if (!cleanedUp) {
			onRemoved({
				id: connector.id,
				label,
				hostProjectId: connector.project_id,
				cleanupScript: result.value.cleanup_script,
				reported: !neverReported,
			})
		}
		return true
	})

	const log = gcpLogState(connector, nowMs)
	const metrics = gcpMetricsState(connector, nowMs)
	const issues = connectionIssues({
		connector,
		log,
		metrics,
		nowMs,
		onRunScript: isAdmin ? () => onConfigure("apply") : null,
	})
	const lastLog = log.kind === "receiving" || log.kind === "idle" ? log.lastLogReceivedAt : null
	const lastRead = "lastMetricsReceivedAt" in metrics ? metrics.lastMetricsReceivedAt : null
	const projects =
		metrics.kind === "receiving" && metrics.projectCount !== null
			? countLabel(metrics.projectCount, "project")
			: null
	const collects = [connector.logs_enabled ? "Logs" : null, connector.metrics_enabled ? "key metrics" : null]
		.filter((part) => part !== null)
		.join(" and ")

	const name = (
		<div className="flex min-w-0 items-center gap-2.5">
			<h3 className="truncate font-mono text-sm font-medium" title={label}>
				{connector.scope_id}
			</h3>
			<Badge variant="meta" size="xs">
				{GCP_SCOPE_NAMES[connector.scope_type]}
			</Badge>
		</div>
	)
	const subtitle = [
		collects === "" ? "Collects nothing" : collects.charAt(0).toUpperCase() + collects.slice(1),
		projects,
		connector.scope_type === "project" ? null : `host ${connector.project_id}`,
	]
		.filter((part) => part !== null)
		.join(" · ")
	const menu = (
		<RowActionsMenu label={`Actions for ${label}`}>
			{isAdmin ? <DropdownMenuItem onClick={() => onConfigure("choose")}>Configure</DropdownMenuItem> : null}
			<DropdownMenuItem render={<Link to="/logs" search={logsSearch(connector)} />}>View logs</DropdownMenuItem>
			{isAdmin ? (
				<>
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onClick={() => setDisconnectOpen(true)}>
						Disconnect
					</DropdownMenuItem>
				</>
			) : null}
		</RowActionsMenu>
	)

	return (
		<Panel className="@container">
			{issues.length === 0 ? (
				// Healthy: one row, the name and the times its data last arrived.
				<div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3 pr-2 pl-4">
					<div className="flex min-w-0 flex-1 basis-56 items-start gap-2.5">
						<span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
							<StatusDot tone="ok" size="lg" />
						</span>
						<div className="flex min-w-0 flex-col gap-0.5">
							{name}
							<p className="truncate text-xs text-muted-foreground">{subtitle}</p>
						</div>
					</div>
					<div className="order-last flex basis-full gap-6 pl-6 @2xl:order-none @2xl:basis-auto @2xl:pl-0">
						<Fact label="Last log">
							{lastLog === null ? "Off" : <RelativeTime value={lastLog} />}
						</Fact>
						<Fact label="Last metrics">
							{lastRead === null ? "Off" : <RelativeTime value={lastRead} />}
						</Fact>
					</div>
					{menu}
				</div>
			) : (
				<>
					<div className="flex flex-col gap-3 px-4 pt-3 pb-4">
						<div className="flex items-center justify-between gap-3">
							<div className="flex min-w-0 flex-col gap-0.5">
								{name}
								{connector.scope_type === "project" ? null : (
									<p className="truncate text-xs text-muted-foreground">{subtitle}</p>
								)}
							</div>
							<div className="-mr-2 shrink-0">{menu}</div>
						</div>
						{issues.map((issue) => (
							<IssueNote key={issue.key} issue={issue} />
						))}
					</div>
					<div className="flex flex-col divide-y divide-border/60 border-t border-border/60 @md:flex-row @md:divide-x @md:divide-y-0">
						<Signal
							name="Logs"
							signal={signalText("logs", log, metrics)}
							link={
								lastLog === null ? undefined : (
									<Link to="/logs" search={logsSearch(connector)} className={SIGNAL_LINK}>
										View logs
										<ArrowRightIcon size={11} />
									</Link>
								)
							}
						/>
						<Signal
							name="Key metrics"
							signal={signalText("metrics", log, metrics)}
						/>
					</div>
				</>
			)}

			{neverReported ? (
				<ConfirmDialog
					open={disconnectOpen}
					onOpenChange={setDisconnectOpen}
					title={`Disconnect ${label}?`}
					confirmLabel="Disconnect"
					onConfirm={disconnect}
				>
					<dl className="flex flex-col gap-3 pb-3 text-sm">
						<div>
							<dt className="font-medium">In Maple</dt>
							<dd className="text-pretty text-muted-foreground">Removes the connection.</dd>
						</div>
						<div>
							<dt className="font-medium">In Google Cloud</dt>
							<dd className="text-pretty text-muted-foreground">
								Nothing should exist: Maple hasn&apos;t seen the setup script run. If it ran
								part of the way, Maple offers the cleanup script afterwards.
							</dd>
						</div>
					</dl>
				</ConfirmDialog>
			) : disconnectOpen ? (
				<GcpDisconnectDialog
					connector={connector}
					disconnecting={disconnecting}
					onDisconnect={() => void disconnect().then((done) => done && setDisconnectOpen(false))}
					onClose={() => setDisconnectOpen(false)}
				/>
			) : null}
		</Panel>
	)
}

/** Every connection, and the clock their states turn on. */
function useGcpConnectors() {
	const status = Option.getOrNull(AsyncResult.value(useAtomValue(gcpStatusQuery())))
	return { connectors: status?.connectors ?? [], nowMs: useLiveClock() }
}

/** The page header's state: the worst connection's, how many of several share it, and how many projects send data. */
export function GcpHeaderStatus() {
	const { connectors, nowMs } = useGcpConnectors()
	const states = connectors.map((connector) => gcpConnectionState(connector, nowMs))
	const worst = gcpWorstState(states)
	const inWorst = states.filter((state) => state === worst).length
	const projects = connectors.reduce(
		(sum, connector) =>
			sum + (connector.scope_type === "project" ? 1 : connector.discovered_project_count),
		0,
	)
	return (
		<div className="flex items-center gap-1.5 font-display text-ui/5 text-muted-foreground">
			<StatusDot tone={HEALTH_TONE[worst === "attention" || worst === "healthy" ? worst : "pending"]} />
			{GCP_CONNECTION_LABEL[worst]}
			{inWorst < connectors.length ? ` · ${inWorst} of ${connectors.length} connections` : null}
			{projects > 1 ? ` · ${countLabel(projects, "project")}` : null}
		</div>
	)
}

/**
 * The Google Cloud integration page. No OAuth: an admin registers a connection for a project,
 * folder or organization and runs the generated script in Cloud Shell. The page shows what each
 * connection collects as status and numbers. Everything that changes a connection, and the script
 * that applies the change, is behind Configure. Everyone but admins sees the status only.
 */
export function GcpIntegrationCard() {
	const statusQuery = gcpStatusQuery()
	const statusResult = useAtomValue(statusQuery)
	const refreshStatus = useAtomRefresh(statusQuery)

	// The gate the API applies. `useIsOrgAdmin` is false until the session lands, so the
	// admin-only note waits for a settled session; the controls stay hidden meanwhile.
	const isAdmin = useIsOrgAdmin()
	const sessionResult = useAtomValue(retainedQuery("auth", "session", {}))
	const showNotAdmin = !isAdmin && !Result.isInitial(sessionResult)

	const [target, setTarget] = useState<GcpConfigureTarget | null>(null)
	// The removed connection whose cleanup script is about to be dismissed.
	const [dismissing, setDismissing] = useState<string | null>(null)
	const [removed, setRemoved] = useAtom(removedGcpConnectorsAtomFamily(getActiveOrgId() ?? "default"))
	// The states turn on the clock: a grant's grace ends, a silent sink becomes overdue.
	const nowMs = useLiveClock()

	// Keep the last loaded status if a poll fails.
	const status = Option.getOrNull(AsyncResult.value(statusResult))
	const connectors = status?.connectors ?? []
	const metricsAvailable = status?.metrics_available === true

	const settling = connectors.some((connector) => gcpConnectionState(connector, nowMs) !== "healthy")
	useIntervalRefresh(refreshStatus, {
		intervalMs: settling ? GCP_SETTLING_REFRESH_MS : STEADY_REFRESH_MS,
		enabled: connectors.length > 0,
	})

	if (Result.isInitial(statusResult)) {
		return <Skeleton className="h-40 w-full rounded-md" />
	}
	if (Result.isFailure(statusResult) && status === null) {
		return (
			<ErrorState
				error={statusResult.cause}
				title="Failed to load the Google Cloud integration"
				onRetry={refreshStatus}
			/>
		)
	}

	const cleanup = removed.map((entry) => (
		<Panel key={entry.id} className="gap-3 border-severity-warn/32 bg-severity-warn/4 px-4 py-3">
			<div>
				<h3 className={GCP_TITLE}>
					{entry.label} {entry.reported ? "disconnected, not cleaned up" : "disconnected"}
				</h3>
				<p className="text-xs/5 text-pretty text-muted-foreground">
					{entry.reported
						? "Google Cloud still holds what the setup script created, and bills for it. Dismiss this once the cleanup script has run."
						: "If the setup script ran part of the way, the cleanup script removes what it created."}
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<GcpOpenCloudShellButton projectId={entry.hostProjectId} />
				<GcpCopyScriptButton script={entry.cleanupScript} label="cleanup script" />
				<Button size="sm" variant="outline" onClick={() => setDismissing(entry.id)}>
					Dismiss
				</Button>
			</div>
		</Panel>
	))
	const dismiss = (
		<ConfirmDialog
			key="dismiss"
			open={dismissing !== null}
			onOpenChange={(open) => (open ? undefined : setDismissing(null))}
			title="Dismiss the cleanup script?"
			description="Dismiss it once the cleanup has run. Maple keeps the script only here, so it can't be shown again."
			tone="default"
			icon={null}
			confirmLabel="Dismiss"
			onConfirm={() => {
				setRemoved(removed.filter((entry) => entry.id !== dismissing))
				setDismissing(null)
			}}
		/>
	)
	const configure =
		target === null ? null : (
			<GcpConfigure
				key="configure"
				target={target}
				connectors={connectors}
				metricsAvailable={metricsAvailable}
				nowMs={nowMs}
				onCreated={(connector) => setTarget({ kind: "connection", id: connector.id, stage: "apply" })}
				onClose={() => setTarget(null)}
			/>
		)

	if (connectors.length === 0) {
		return (
			<div className="flex flex-col gap-4">
				{cleanup}
				<IntegrationEmpty icon={GoogleCloudIcon} backerIcon={GoogleCloudMonoIcon} accent={GCP_ACCENT}>
					<IntegrationEmptyFeatures>
						<IntegrationEmptyFeature
							label="Logs"
							title="Google Cloud's logs"
							description="Request, audit and managed-service logs. GKE container logs stay out by default."
						/>
						<IntegrationEmptyFeature
							label="Metrics"
							title="Workloads, no agents"
							description="Cloud Run, GKE, Compute Engine, Cloud SQL and more, read every 5 minutes."
						/>
						<IntegrationEmptyFeature
							label="Access"
							title="One script, read-only"
							description="You run it in Cloud Shell. No keys, no write access for Maple."
						/>
					</IntegrationEmptyFeatures>
					<IntegrationEmptyCard>
						<IntegrationEmptyMedia />
						{isAdmin ? (
							<>
								<IntegrationEmptyHint>
									Connect a project, folder or organization. Its logs, workloads and
									resources appear here.
								</IntegrationEmptyHint>
								<Button onClick={() => setTarget({ kind: "new" })}>
									<GoogleCloudMonoIcon />
									Connect Google Cloud
								</Button>
							</>
						) : (
							<IntegrationEmptyHint>
								A Maple organization admin connects Google Cloud by running a setup script in
								Cloud Shell.
							</IntegrationEmptyHint>
						)}
					</IntegrationEmptyCard>
				</IntegrationEmpty>
				{configure}
				{dismiss}
			</div>
		)
	}

	// Worst first: what needs its admin is at the top, however many connections there are.
	const ordered = connectors.toSorted(
		(a, b) =>
			GCP_STATE_ORDER.indexOf(gcpConnectionState(a, nowMs)) -
			GCP_STATE_ORDER.indexOf(gcpConnectionState(b, nowMs)),
	)

	// Sans for words, mono for ids, times and commands.
	return (
		<div className="flex flex-col gap-4 font-display">
			{cleanup}
			<section className="flex min-w-0 flex-col gap-3">
				<SectionHeading
					title="Connections"
					count={connectors.length > 1 ? connectors.length : undefined}
					actions={
						isAdmin ? (
							<Button size="sm" variant="outline" onClick={() => setTarget({ kind: "new" })}>
								Add connection
							</Button>
						) : undefined
					}
				/>
				{ordered.map((connector) => (
					<GcpConnection
						key={connector.id}
						connector={connector}
						isAdmin={isAdmin}
						nowMs={nowMs}
						onConfigure={(stage) => setTarget({ kind: "connection", id: connector.id, stage })}
						onRemoved={(entry) => setRemoved([...removed, entry])}
					/>
				))}
				{showNotAdmin ? (
					<p className="text-xs text-muted-foreground">
						Only Maple organization admins can add, configure or disconnect connections.
					</p>
				) : null}
			</section>
			{configure}
			{dismiss}
		</div>
	)
}
