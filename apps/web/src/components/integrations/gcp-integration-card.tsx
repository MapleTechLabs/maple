import { useState } from "react"
import type React from "react"
import { Link } from "@tanstack/react-router"
import { Exit, Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { DropdownMenuItem } from "@maple/ui/components/ui/dropdown-menu"
import { Panel } from "@maple/ui/components/ui/panel"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import {
	removedGcpConnectorsAtomFamily,
	type RemovedGcpConnector,
} from "@/atoms/gcp-removed-connectors-atoms"
import { ErrorState } from "@/components/common/error-state"
import { RelativeTime } from "@/components/common/relative-time"
import { SectionHeading } from "@/components/common/section-heading"
import { AlertWarningIcon, GoogleCloudIcon, GoogleCloudMonoIcon } from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { useLiveClock } from "@/hooks/use-live-clock"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { Result, useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { showErrorToast } from "@/lib/error-toast"
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
	type GcpCapability,
} from "./gcp-connector-state"
import { GcpUsageBand } from "./gcp-usage-cards"
import { GCP_ACCENT, gcpStatusQuery } from "./integration-catalog"
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
 * what to do under it, one sentence a line, and what Google answered as fine print.
 */
export function GcpMessage({ text }: { text: string }) {
	const { headline, body, answer } = gcpMessageParts(text)
	return (
		<div className="flex flex-col gap-1 [overflow-wrap:anywhere]">
			<p className="font-medium text-pretty text-foreground">
				<Linked text={headline} />
			</p>
			{body.length === 0 ? null : body.length === 1 ? (
				<p className="text-pretty text-muted-foreground">
					<Linked text={body[0]} />
				</p>
			) : (
				<ul className="list-disc pl-4 text-pretty text-muted-foreground">
					{body.map((sentence) => (
						<li key={sentence}>
							<Linked text={sentence} />
						</li>
					))}
				</ul>
			)}
			{answer === null ? null : <p className="text-2xs text-muted-foreground/80">{answer}</p>}
		</div>
	)
}

const ASK_ADMIN = "Ask a Maple organization admin to run the setup script."

/**
 * What hangs under a connection's row when there is something to know or do: a plain hint, or a
 * warning or failure. `run` is the way into the script: the card's one filled button for an admin,
 * a sentence for everyone else.
 */
function Band({
	tone,
	run,
	children,
}: {
	tone?: "warn" | "crit"
	run?: { readonly label: string; readonly onRun: (() => void) | null }
	children: React.ReactNode
}) {
	return (
		<div
			role={tone === undefined ? "note" : "status"}
			className={cn(
				"flex flex-col gap-2.5 border-t py-2.5 pr-3 pl-4 text-xs/[18px] @xl:flex-row @xl:items-start",
				tone === "crit"
					? "border-severity-error/32 bg-severity-error/4"
					: tone === "warn"
						? "border-severity-warn/32 bg-severity-warn/4"
						: "border-border/60 text-muted-foreground",
			)}
		>
			<div className="flex min-w-0 flex-1 gap-2.5">
				{tone === undefined ? null : (
					<AlertWarningIcon
						size={14}
						className={cn(
							"mt-0.5 shrink-0",
							tone === "crit" ? "text-severity-error" : "text-severity-warn",
						)}
						aria-hidden
					/>
				)}
				<div className="flex min-w-0 flex-col gap-1">
					{children}
					{run?.onRun === null ? <p className="text-foreground/80">{ASK_ADMIN}</p> : null}
				</div>
			</div>
			{run === undefined || run.onRun === null ? null : (
				<Button size="sm" className="shrink-0 self-start" onClick={run.onRun}>
					{run.label}
				</Button>
			)}
		</div>
	)
}

/** A band's headline. */
function Headline({ children }: { children: React.ReactNode }) {
	return <p className="font-medium text-pretty text-foreground">{children}</p>
}

function Retries() {
	return (
		<p className="text-pretty text-muted-foreground">
			Maple retries every 5 minutes. If this lasts an hour, write to{" "}
			<a href="mailto:support@maple.dev" className={GCP_LINK}>
				support@maple.dev
			</a>
			.
		</p>
	)
}

/** One capability in a connection's row: its name, its state in a word or two, when it last delivered. */
function Status({
	name,
	status,
	detail,
	className,
}: {
	name: string
	/** A null tone is a capability that is off. */
	status: { readonly tone: Tone | null; readonly label: string }
	detail?: React.ReactNode
	className?: string
}) {
	return (
		<div className={cn("flex min-w-0 items-baseline gap-2 text-xs", className)}>
			<span className="shrink-0 text-muted-foreground">{name}</span>
			<span
				className={cn(
					"shrink-0 font-medium",
					status.tone === null
						? "text-muted-foreground"
						: status.tone === "crit" || status.tone === "warn"
							? TONE_TEXT[status.tone]
							: null,
				)}
			>
				{status.label}
			</span>
			{detail === undefined || detail === null ? null : (
				<span className="truncate text-muted-foreground">{detail}</span>
			)}
		</div>
	)
}

const OFF = { tone: null, label: "Off" } as const

/**
 * What a connection needs its admin to do about the script: finish the setup, or apply a saved
 * change. Both lead to the same place, the apply step of the configuration.
 */
function ScriptDue({
	connector,
	needed,
	nowMs,
	onRunScript,
}: {
	connector: V2GcpConnector
	needed: "setup-pending" | "changes-pending"
	nowMs: number
	/** Absent for non-admins. */
	onRunScript: (() => void) | null
}) {
	const cleanedUp = connector.applied_logs_enabled === false && connector.applied_metrics_enabled === false
	const lines =
		needed === "setup-pending"
			? [
					connector.setup_reported_at === null
						? "Google Cloud has nothing of Maple's yet. Running the setup script takes about a minute."
						: "The last run stopped part of the way. Run the script again: it continues where it stopped.",
				]
			: gcpPendingChanges(connector, nowMs)
	return (
		<Band
			tone="warn"
			run={{ label: needed === "setup-pending" ? "Finish setup" : "Apply changes", onRun: onRunScript }}
		>
			<Headline>
				{needed === "setup-pending" ? "Setup pending" : "Changes not applied in Google Cloud"}
			</Headline>
			{lines.length === 1 ? (
				<p className="text-pretty text-muted-foreground">{lines[0]}</p>
			) : (
				<ul className="list-disc pl-4 text-pretty text-muted-foreground">
					{lines.map((line) => (
						<li key={line}>{line}</li>
					))}
				</ul>
			)}
			{onRunScript !== null && needed === "changes-pending" && cleanedUp ? (
				<p className="text-muted-foreground">
					To remove the connection instead, choose Disconnect in its menu.
				</p>
			) : null}
		</Band>
	)
}

function GcpConnection({
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
	const resourcesError = metrics.kind === "receiving" ? metrics.resourcesError : null
	const state = gcpConnectionState(connector, nowMs)
	const tone: Tone =
		log.kind === "failing" || metrics.kind === "failing"
			? "crit"
			: state === "healthy"
				? resourcesError === null
					? "ok"
					: "warn"
				: state === "waiting"
					? "neutral"
					: "warn"
	const onRunScript = isAdmin ? () => onConfigure("apply") : null
	const needed = gcpScriptNeeded(connector, nowMs)
	// The card has one filled button. The script being due takes it; else the first failure that
	// another run repairs does.
	const repairs = needed === null ? gcpRunAsked(connector, nowMs)[0] : undefined
	const rerun = (capability: GcpCapability) =>
		repairs === capability ? { label: "Run the script again", onRun: onRunScript } : undefined
	const lastRead =
		"lastMetricsReceivedAt" in metrics && metrics.lastMetricsReceivedAt !== null ? (
			<RelativeTime value={metrics.lastMetricsReceivedAt} prefix="last read" />
		) : undefined

	return (
		<Panel className="@container">
			{/* One line where the card is wide: the name, a lane for each capability, the actions. Narrower, the capabilities go under the name. */}
			<div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-2.5 pr-3 pl-4">
				<div className="flex min-w-0 flex-1 basis-56 items-center gap-2.5">
					{/* As wide as a band's icon, so the name, the wrapped statuses and a band's text share a lane. */}
					<span className="flex w-3.5 shrink-0 justify-center">
						<StatusDot tone={tone} />
					</span>
					<h3 className="truncate text-sm font-medium" title={label}>
						{connector.scope_id}
					</h3>
					<Badge variant="meta" size="xs">
						{GCP_SCOPE_NAMES[connector.scope_type]}
					</Badge>
					{connector.scope_type === "project" ? null : (
						<span className="truncate text-xs text-muted-foreground">
							host <span className="font-mono">{connector.project_id}</span>
						</span>
					)}
				</div>
				<div className="order-last flex basis-full flex-col gap-x-6 gap-y-1 pl-6 @md:flex-row @5xl:order-none @5xl:basis-auto @5xl:pl-0">
					<Status
						name="Logs"
						className="@5xl:w-59"
						status={log.kind === "off" ? OFF : GCP_LOG_STATUS[log.kind]}
						detail={
							log.kind === "receiving" || log.kind === "idle" ? (
								<RelativeTime value={log.lastLogReceivedAt} prefix="last entry" />
							) : log.kind === "failing" && log.lastLogReceivedAt !== null ? (
								<RelativeTime value={log.lastLogReceivedAt} prefix="last accepted" />
							) : undefined
						}
					/>
					<Status
						name="Metrics"
						className="@5xl:w-84"
						status={
							metrics.kind === "off"
								? OFF
								: resourcesError === null
									? GCP_METRICS_STATUS[metrics.kind]
									: // Metrics arrive; what is short is the list of resources.
										{ tone: "warn", label: "Receiving, resource list incomplete" }
						}
						detail={lastRead}
					/>
				</div>
				{isAdmin ? (
					<div className="flex shrink-0 items-center gap-1">
						<Button size="sm" variant="outline" onClick={() => onConfigure("choose")}>
							Configure
						</Button>
						<RowActionsMenu label={`More actions for ${label}`}>
							<DropdownMenuItem variant="destructive" onClick={() => setDisconnectOpen(true)}>
								Disconnect
							</DropdownMenuItem>
						</RowActionsMenu>
					</div>
				) : null}
			</div>

			{needed === null ? null : (
				<ScriptDue connector={connector} needed={needed} nowMs={nowMs} onRunScript={onRunScript} />
			)}
			{log.kind === "failing" ? (
				<Band tone="crit" run={rerun("logs")}>
					<GcpMessage text={log.error} />
				</Band>
			) : log.kind !== "waiting" ? null : log.overdue ? (
				<Band>
					<Headline>No log entry in 20 minutes</Headline>
					<p className="text-pretty">
						Nothing that passes the filter was logged, or the sink can&apos;t publish. Write a
						test entry. If it isn&apos;t here within a minute, open Configure and run the setup
						script again.
					</p>
					<div className="pt-1">
						<GcpCommand>
							{`gcloud logging write maple-test "hello from Maple" --project=${connector.project_id}`}
						</GcpCommand>
					</div>
				</Band>
			) : (
				<Band>
					<p className="text-pretty">
						A new sink takes about 10 minutes to start forwarding. Entries logged before that are
						not forwarded.
					</p>
				</Band>
			)}
			{metrics.kind === "failing" ? (
				<Band tone="crit" run={rerun("metrics")}>
					<GcpMessage text={metrics.error} />
				</Band>
			) : metrics.kind === "incomplete" ? (
				<Band tone="warn" run={rerun("metrics")}>
					<GcpMessage text={metrics.error} />
				</Band>
			) : metrics.kind === "stalled" ? (
				<Band tone="warn">
					<Headline>No metrics in 30 minutes</Headline>
					<Retries />
				</Band>
			) : metrics.kind === "waiting" ? (
				<Band>
					{metrics.overdue ? (
						<>
							<Headline>No metrics have arrived yet</Headline>
							<Retries />
						</>
					) : (
						<p className="text-pretty">The first metrics arrive within about 10 minutes.</p>
					)}
				</Band>
			) : resourcesError === null ? null : (
				<Band tone="warn">
					<GcpMessage text={resourcesError} />
				</Band>
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
		catchUp: true,
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

	return (
		<div className="flex flex-col gap-4">
			{cleanup}
			<GcpUsageBand connectors={connectors} />
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
