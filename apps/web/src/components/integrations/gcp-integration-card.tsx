import { Fragment, useState } from "react"
import type React from "react"
import { Link } from "@tanstack/react-router"
import { Exit, Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { DropdownMenuItem } from "@maple/ui/components/ui/dropdown-menu"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Panel } from "@maple/ui/components/ui/panel"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { countLabel } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"

import {
	removedGcpConnectorsAtomFamily,
	type RemovedGcpConnector,
} from "@/atoms/gcp-removed-connectors-atoms"
import { ErrorState } from "@/components/common/error-state"
import { RelativeTime } from "@/components/common/relative-time"
import { SectionHeading } from "@/components/common/section-heading"
import { AlertWarningIcon, ArrowRightIcon, GoogleCloudIcon, GoogleCloudMonoIcon } from "@/components/icons"
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
	gcpWorstState,
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

/** A hint under a capability: a headline, at most two short lines, then one thing to do. */
function Notice({
	title,
	children,
	action,
}: {
	title: string
	children?: React.ReactNode
	action?: React.ReactNode
}) {
	return (
		<div role="note" className="flex flex-col gap-1.5">
			<p className="font-semibold text-pretty text-foreground">{title}</p>
			{children === undefined ? null : (
				<div className="text-pretty text-muted-foreground">{children}</div>
			)}
			{action}
		</div>
	)
}

/**
 * One thing a connection collects, as status: its name and state, under them what it last
 * delivered and where that shows up, then a hint when there is something to know or do.
 */
function Capability({
	title,
	status,
	facts = [],
	link,
	children,
}: {
	title: string
	/** A null tone is the hollow dot of a capability that is off. */
	status: { readonly tone: Tone | null; readonly label: string }
	facts?: ReadonlyArray<React.ReactNode>
	/** Where the data shows up, once it does. */
	link?: React.ReactNode
	children?: React.ReactNode
}) {
	const shown = [...facts, link].filter((fact) => fact !== null && fact !== undefined && fact !== false)
	return (
		<section className="flex min-w-0 flex-col gap-3 p-4 text-ui/5">
			<div className="flex flex-col gap-1">
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
					<h4 className="text-sm font-semibold">{title}</h4>
					<span className="flex items-center gap-1.5">
						{status.tone === null ? (
							// Off: a hollow dot, so the label lines up with the rows that have one.
							<span
								aria-hidden
								className="size-1.5 rounded-full border border-muted-foreground/60"
							/>
						) : (
							<StatusDot tone={status.tone} />
						)}
						{status.label}
					</span>
				</div>
				{shown.length === 0 ? null : (
					<p className="text-pretty text-muted-foreground">
						{shown.map((fact, index) => (
							<Fragment key={index}>
								{index === 0 ? null : " · "}
								{fact}
							</Fragment>
						))}
					</p>
				)}
			</div>
			{children}
		</section>
	)
}

const DATA_LINK = "inline-flex items-center gap-1 whitespace-nowrap text-foreground/80 hover:text-foreground"

interface CapabilityProps {
	readonly connector: V2GcpConnector
	readonly nowMs: number
}

function LogCapability({ connector, nowMs }: CapabilityProps) {
	const title = "Log forwarding"
	const state = gcpLogState(connector, nowMs)
	if (state.kind === "off") {
		return (
			<Capability
				title={title}
				status={{ tone: null, label: "Off" }}
				facts={[
					state.stillSetUp ? "Maple discards what Google Cloud still forwards" : "Not collected",
				]}
			/>
		)
	}
	const status = GCP_LOG_STATUS[state.kind]
	switch (state.kind) {
		case "failing":
			return (
				<Capability
					title={title}
					status={status}
					facts={[
						state.lastLogReceivedAt === null ? null : (
							<RelativeTime
								key="at"
								value={state.lastLogReceivedAt}
								prefix="Last accepted entry"
							/>
						),
					]}
				>
					<GcpMessage text={state.error} />
				</Capability>
			)
		case "setup-pending":
			return <Capability title={title} status={status} facts={["Starts once the script has run"]} />
		case "setup-running":
			return <Capability title={title} status={status} facts={["The script is still working"]} />
		case "waiting":
			return (
				<Capability title={title} status={status}>
					{state.overdue ? (
						<Notice
							title="No log entry in 20 minutes"
							action={
								<GcpCommand>
									{`gcloud logging write maple-test "hello from Maple" --project=${connector.project_id}`}
								</GcpCommand>
							}
						>
							<p>Nothing that passes the filter was logged, or the sink can&apos;t publish.</p>
							<p>
								Write a test entry. If it isn&apos;t here within a minute, open Configure and
								run the setup script again.
							</p>
						</Notice>
					) : (
						<Notice title="A new sink takes about 10 minutes to start forwarding">
							<p>Entries logged before that are not forwarded.</p>
						</Notice>
					)}
				</Capability>
			)
		case "idle":
		case "receiving":
			return (
				<Capability
					title={title}
					status={status}
					facts={[<RelativeTime key="at" value={state.lastLogReceivedAt} prefix="Last entry" />]}
					link={
						<Link
							to="/logs"
							// The entries this connection forwarded: ingest stamps each with the connection's id.
							search={{
								attrs: [
									encodeLogAttributeFilter({
										source: "resource",
										key: "maple_gcp_connector_id",
										value: connector.id,
										negated: false,
									}),
								],
							}}
							className={DATA_LINK}
						>
							View logs
							<ArrowRightIcon size={11} />
						</Link>
					}
				/>
			)
	}
}

function MetricsCapability({ connector, nowMs }: CapabilityProps) {
	const title = "Metrics and resources"
	const state = gcpMetricsState(connector, nowMs)
	if (state.kind === "off") {
		return (
			<Capability
				title={title}
				status={{ tone: null, label: "Off" }}
				facts={[state.stillSetUp ? "Maple no longer uses its service account" : "Not collected"]}
			/>
		)
	}
	const status = GCP_METRICS_STATUS[state.kind]
	const lastRead = (at: string | null) =>
		at === null ? null : <RelativeTime key="at" value={at} prefix="Last metrics" />
	switch (state.kind) {
		case "setup-pending":
			return <Capability title={title} status={status} facts={["Starts once the script has run"]} />
		case "setup-running":
			return <Capability title={title} status={status} facts={["The script is still working"]} />
		case "waiting":
			return (
				<Capability title={title} status={status}>
					{state.overdue ? (
						<Notice title="No metrics have arrived yet">
							<p>Maple retries every 5 minutes.</p>
							<p>
								If this lasts an hour, write to{" "}
								<a href="mailto:support@maple.dev" className={GCP_LINK}>
									support@maple.dev
								</a>
								.
							</p>
						</Notice>
					) : (
						<Notice title="The first metrics arrive within about 10 minutes" />
					)}
				</Capability>
			)
		case "failing":
			return (
				<Capability title={title} status={status} facts={[lastRead(state.lastMetricsReceivedAt)]}>
					<GcpMessage text={state.error} />
				</Capability>
			)
		case "incomplete":
			return (
				<Capability title={title} status={status} facts={[lastRead(state.lastMetricsReceivedAt)]}>
					<GcpMessage text={state.error} />
				</Capability>
			)
		case "stalled":
			return (
				<Capability title={title} status={status} facts={[lastRead(state.lastMetricsReceivedAt)]}>
					<Notice title="No metrics in 30 minutes">
						<p>Maple retries every 5 minutes.</p>
						<p>
							If this lasts an hour, write to{" "}
							<a href="mailto:support@maple.dev" className={GCP_LINK}>
								support@maple.dev
							</a>
							.
						</p>
					</Notice>
				</Capability>
			)
		case "receiving":
			return (
				<Capability
					title={title}
					// Metrics arrive; what is short is the list of resources, and the dot says so.
					status={
						state.resourcesError === null
							? status
							: { tone: "warn", label: "Receiving metrics, resource list incomplete" }
					}
					facts={[
						lastRead(state.lastMetricsReceivedAt),
						state.projectCount === null ? null : countLabel(state.projectCount, "project"),
					]}
				>
					{state.resourcesError === null ? null : <GcpMessage text={state.resourcesError} />}
				</Capability>
			)
	}
}

/**
 * What a connection needs its admin to do, in a sentence, with the one filled button of the card:
 * finish the setup, apply a saved change, or run the script again because a failure asks for it.
 * Every one of them leads to the same place, the apply step of the configuration.
 */
function Attention({
	connector,
	nowMs,
	onRunScript,
}: {
	connector: V2GcpConnector
	nowMs: number
	/** Absent for non-admins. */
	onRunScript: (() => void) | null
}) {
	const needed = gcpScriptNeeded(connector, nowMs)
	const asked = gcpRunAsked(connector, nowMs)
	if (needed === null && asked.length === 0) return null
	const changes = gcpPendingChanges(connector, nowMs)
	const cleanedUp = connector.applied_logs_enabled === false && connector.applied_metrics_enabled === false
	const lines =
		needed === "setup-pending"
			? [
					connector.setup_reported_at === null
						? "Google Cloud has nothing of Maple's yet. Running the setup script takes about a minute."
						: "The last run stopped part of the way. Run the script again: it continues where it stopped.",
				]
			: needed === "changes-pending"
				? changes
				: [
						asked.length === 2
							? "Log forwarding and metrics report failures that another run repairs."
							: asked[0] === "logs"
								? "Log forwarding reports a failure that another run repairs."
								: "Metrics report a failure that another run repairs.",
					]
	return (
		<div className="px-4 pt-4">
			<Alert variant="warn" role="status">
				<AlertWarningIcon aria-hidden />
				<AlertTitle className="font-semibold">
					{needed === "setup-pending"
						? "Setup pending"
						: needed === "changes-pending"
							? "Changes not applied in Google Cloud"
							: "The setup script needs to run again"}
				</AlertTitle>
				<AlertDescription className="gap-1 text-ui/5 text-pretty">
					{lines.length === 1 ? (
						<p>{lines[0]}</p>
					) : (
						<ul className="list-disc pl-4">
							{lines.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					)}
					{onRunScript === null ? (
						<p className="text-foreground/80">
							Ask a Maple organization admin to run the setup script.
						</p>
					) : needed === "changes-pending" && cleanedUp ? (
						<p>To remove the connection instead, choose Disconnect in its menu.</p>
					) : null}
				</AlertDescription>
				{onRunScript === null ? null : (
					<AlertAction>
						<Button size="sm" onClick={onRunScript}>
							{needed === "setup-pending"
								? "Finish setup"
								: needed === "changes-pending"
									? "Apply changes"
									: "Run the script again"}
						</Button>
					</AlertAction>
				)}
			</Alert>
		</div>
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

	const onRunScript = isAdmin ? () => onConfigure("apply") : null

	return (
		<Panel className="@container">
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b px-4 py-3">
				<h3 className="flex min-w-0 items-center gap-2.5">
					<Badge variant="meta">{GCP_SCOPE_NAMES[connector.scope_type]}</Badge>
					<span className="font-mono text-sm font-medium [overflow-wrap:anywhere]">
						{connector.scope_id}
					</span>
				</h3>
				{connector.scope_type !== "project" ? (
					<p className="text-ui/5 text-muted-foreground">
						Host project{" "}
						<span className="font-mono [overflow-wrap:anywhere]">{connector.project_id}</span>
					</p>
				) : null}
				{isAdmin ? (
					<div className="ml-auto flex shrink-0 items-center gap-1">
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
			<Attention connector={connector} nowMs={nowMs} onRunScript={onRunScript} />
			{/* Side by side wherever the panel is wide enough; a long error or command wraps in its column. */}
			<div className="grid grid-cols-1 divide-y divide-border/60 @2xl:grid-cols-2 @2xl:divide-x @2xl:divide-y-0">
				<LogCapability connector={connector} nowMs={nowMs} />
				<MetricsCapability connector={connector} nowMs={nowMs} />
			</div>

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

/** The newest of the times, null when none has arrived yet. */
const latest = (times: ReadonlyArray<string | null>): string | null =>
	times.reduce<string | null>(
		(newest, at) =>
			at !== null && (newest === null || Date.parse(at) > Date.parse(newest)) ? at : newest,
		null,
	)

/** Every connection, and the clock their states turn on. */
function useGcpConnectors() {
	const status = Option.getOrNull(AsyncResult.value(useAtomValue(gcpStatusQuery())))
	return { connectors: status?.connectors ?? [], nowMs: useLiveClock() }
}

/** The page header's state: the worst connection's, and how many of several share it. */
export function GcpHeaderStatus() {
	const { connectors, nowMs } = useGcpConnectors()
	const states = connectors.map((connector) => gcpConnectionState(connector, nowMs))
	const worst = gcpWorstState(states)
	const inWorst = states.filter((state) => state === worst).length
	return (
		<div className="flex items-center gap-1.5 font-display text-ui/5 text-muted-foreground">
			<StatusDot tone={HEALTH_TONE[worst === "attention" || worst === "healthy" ? worst : "pending"]} />
			{GCP_CONNECTION_LABEL[worst]}
			{inWorst < connectors.length ? ` · ${inWorst} of ${connectors.length} connections` : null}
		</div>
	)
}

/** The page header's facts: when each kind of data last arrived, and how many projects send it. */
export function GcpHeaderFacts() {
	const { connectors } = useGcpConnectors()
	const logs = connectors.filter((connector) => connector.logs_enabled)
	const metrics = connectors.filter((connector) => connector.metrics_enabled)
	const projects = connectors.reduce(
		(sum, connector) =>
			sum + (connector.scope_type === "project" ? 1 : connector.discovered_project_count),
		0,
	)
	const when = (times: ReadonlyArray<string | null>) => {
		const at = latest(times)
		return at === null ? "none yet" : <RelativeTime value={at} />
	}
	const facts = [
		logs.length === 0
			? null
			: {
					label: "Last log entry",
					value: when(logs.map((connector) => connector.last_log_received_at)),
				},
		metrics.length === 0
			? null
			: {
					label: "Last metrics",
					value: when(metrics.map((connector) => connector.last_metrics_received_at)),
				},
		projects === 0 ? null : { label: "Projects", value: projects },
	].filter((fact) => fact !== null)
	return (
		<dl className="flex flex-wrap gap-x-8 gap-y-1 font-display text-ui/5">
			{facts.map((fact) => (
				<div key={fact.label} className="flex items-baseline gap-2">
					<dt className="text-muted-foreground">{fact.label}</dt>
					<dd className="font-mono text-foreground">{fact.value}</dd>
				</div>
			))}
		</dl>
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
