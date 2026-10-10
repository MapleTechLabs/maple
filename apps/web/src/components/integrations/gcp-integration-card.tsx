import { Fragment, useState } from "react"
import type React from "react"
import { Link } from "@tanstack/react-router"
import { Exit, Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { DropdownMenuItem } from "@maple/ui/components/ui/dropdown-menu"
import { Panel } from "@maple/ui/components/ui/panel"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { countLabel } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

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
} from "./gcp-connector-state"
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

/** A hint under a capability: a headline, at most two short lines, then one thing to do. */
function Notice({
	tone,
	title,
	children,
	action,
}: {
	tone?: "warn" | "crit"
	title?: string
	children?: React.ReactNode
	action?: React.ReactNode
}) {
	return (
		<Alert variant={tone} size="sm" role="note" className="mt-1">
			{title === undefined ? null : <AlertTitle>{title}</AlertTitle>}
			<AlertDescription className="gap-2 leading-5">
				{children}
				{action === undefined ? null : <div>{action}</div>}
			</AlertDescription>
		</Alert>
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
	const shown = facts.filter((fact) => fact !== null && fact !== undefined && fact !== false)
	return (
		<section className="flex min-w-0 flex-col gap-1 px-4 py-3 text-xs/5">
			{/* The state sits beside the name where both fit and under it where they don't, for both rows alike. */}
			<div className="flex flex-col gap-x-4 @sm:flex-row @sm:items-center @sm:justify-between group-data-stacked/capabilities:@sm:justify-start">
				<h4 className={GCP_TITLE}>{title}</h4>
				<span className="flex items-center gap-1.5 font-medium">
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
			{shown.length === 0 && link === undefined ? null : (
				<div className="flex flex-wrap items-center justify-between gap-x-4 text-muted-foreground group-data-stacked/capabilities:justify-start">
					<span className="text-pretty">
						{shown.map((fact, index) => (
							<Fragment key={index}>
								{index === 0 ? null : " · "}
								{fact}
							</Fragment>
						))}
					</span>
					{link === undefined ? null : (
						<span className="ml-auto group-data-stacked/capabilities:ml-0">{link}</span>
					)}
				</div>
			)}
			{children}
		</section>
	)
}

const DATA_LINK = "inline-flex shrink-0 items-center gap-1 text-foreground/80 hover:text-foreground"

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
					<Notice tone="crit">
						<GcpMessage text={state.error} />
					</Notice>
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
					<Notice tone="crit">
						<GcpMessage text={state.error} />
					</Notice>
				</Capability>
			)
		case "incomplete":
			return (
				<Capability title={title} status={status} facts={[lastRead(state.lastMetricsReceivedAt)]}>
					<Notice tone="warn">
						<GcpMessage text={state.error} />
					</Notice>
				</Capability>
			)
		case "stalled":
			return (
				<Capability title={title} status={status} facts={[lastRead(state.lastMetricsReceivedAt)]}>
					<Notice tone="warn" title="No metrics in 30 minutes">
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
					{state.resourcesError === null ? null : (
						<Notice tone="warn">
							<GcpMessage text={state.resourcesError} />
						</Notice>
					)}
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
		<div
			role="status"
			className={cn(
				"flex flex-col gap-3 border-t px-4 py-3 text-xs/5 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6",
				needed === null
					? "border-severity-error/32 bg-severity-error/4"
					: "border-severity-warn/32 bg-severity-warn/4",
			)}
		>
			<div className="flex min-w-0 gap-2">
				<AlertWarningIcon
					size={14}
					className={cn(
						"mt-0.5 shrink-0",
						needed === null ? "text-severity-error" : "text-severity-warn",
					)}
					aria-hidden
				/>
				<div className="min-w-0">
					<p className="text-sm font-medium">
						{needed === "setup-pending"
							? "Setup pending"
							: needed === "changes-pending"
								? "Changes not applied in Google Cloud"
								: "The setup script needs to run again"}
					</p>
					{lines.length === 1 ? (
						<p className="text-pretty text-muted-foreground">{lines[0]}</p>
					) : (
						<ul className="list-disc pl-4 text-pretty text-muted-foreground">
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
						<p className="text-muted-foreground">
							To remove the connection instead, choose Disconnect in its menu.
						</p>
					) : null}
				</div>
			</div>
			{onRunScript === null ? null : (
				<Button size="sm" className="shrink-0 self-start @xl:self-center" onClick={onRunScript}>
					{needed === "setup-pending"
						? "Finish setup"
						: needed === "changes-pending"
							? "Apply changes"
							: "Run the script again"}
				</Button>
			)}
		</div>
	)
}

function GcpConnection({
	connector,
	isAdmin,
	alone,
	nowMs,
	onConfigure,
	onRemoved,
}: {
	connector: V2GcpConnector
	isAdmin: boolean
	/** The only connection. */
	alone: boolean
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

	const state = gcpConnectionState(connector, nowMs)
	// Side by side while each is a line of status or a hint of a line or two. A failure or a command
	// to copy takes the card's width: it reads in fewer lines there, and no half stays empty beside it.
	const log = gcpLogState(connector, nowMs)
	const metrics = gcpMetricsState(connector, nowMs)
	const hinted =
		log.kind === "failing" ||
		(log.kind === "waiting" && log.overdue) ||
		metrics.kind === "failing" ||
		metrics.kind === "incomplete" ||
		(metrics.kind === "receiving" && metrics.resourcesError !== null)
	const onRunScript = isAdmin ? () => onConfigure("apply") : null

	return (
		<Panel className="@container">
			<div className="flex flex-col gap-2 px-4 py-3 @md:flex-row @md:items-start @md:justify-between @md:gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<h3 className={GCP_TITLE}>
							{GCP_SCOPE_NAMES[connector.scope_type]}{" "}
							<span className="[overflow-wrap:anywhere]">{connector.scope_id}</span>
						</h3>
						{/* A state the band under the header spells out needs no badge beside it, and the
						    only connection none at all: the page header names its state. */}
						{alone ? null : state === "attention" ? (
							<Badge variant="warn">{GCP_CONNECTION_LABEL[state]}</Badge>
						) : state === "waiting" ? (
							<Badge variant="outline">{GCP_CONNECTION_LABEL[state]}</Badge>
						) : null}
					</div>
					{connector.scope_type !== "project" ? (
						<p className="text-xs/5 text-muted-foreground">
							Host project{" "}
							<span className="font-mono [overflow-wrap:anywhere]">{connector.project_id}</span>
						</p>
					) : null}
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
			<Attention connector={connector} nowMs={nowMs} onRunScript={onRunScript} />
			<div
				data-stacked={hinted ? "" : undefined}
				className={cn(
					"group/capabilities grid grid-cols-1 divide-y divide-border/60 border-t border-border/60",
					hinted ? null : "@2xl:grid-cols-2 @2xl:divide-x @2xl:divide-y-0",
				)}
			>
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
		return <Skeleton className="h-40 w-full rounded-lg" />
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
									<GoogleCloudMonoIcon size={16} />
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
						alone={connectors.length === 1}
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
