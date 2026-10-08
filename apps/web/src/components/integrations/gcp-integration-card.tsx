import { useState } from "react"
import type React from "react"
import { Exit, Option, Schema } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { GcpProjectId } from "@maple/domain/primitives"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Field, FieldDescription, FieldError, FieldLabel } from "@maple/ui/components/ui/field"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Input } from "@maple/ui/components/ui/input"
import { Item, ItemActions, ItemContent, ItemMedia } from "@maple/ui/components/ui/item"
import { Panel } from "@maple/ui/components/ui/panel"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Switch } from "@maple/ui/components/ui/switch"
import { cn } from "@maple/ui/lib/utils"

import { ErrorState } from "@/components/common/error-state"
import { RelativeTime } from "@/components/common/relative-time"
import { REPLAY_BLOCK_CLASS } from "@/components/common/replay-privacy"
import { CircleWarningIcon, ExternalLinkIcon, GoogleCloudIcon, GoogleCloudMonoIcon } from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { errorMessage, showErrorToast } from "@/lib/error-toast"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { cloudShellUrl, gcpConnectorState } from "./gcp-connector-state"
import { GCP_ACCENT, IntegrationIconPlate, gcpStatusQuery } from "./integration-catalog"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"

const REACTIVITY_KEYS = ["gcpIntegration"]

/** Fast enough to watch the first log land, cheap next to the push traffic itself. */
const WAITING_REFRESH_MS = 10_000

const decodeProjectId = Schema.decodeUnknownOption(GcpProjectId)

/** A disconnected project's cleanup script, shown until dismissed. It carries no secret. */
interface RemovedProject {
	readonly projectId: string
	readonly cleanupScript: string
}

function OpenCloudShellButton({ projectId }: { projectId: string }) {
	return (
		<Button
			size="sm"
			variant="outline"
			render={
				<a href={cloudShellUrl(projectId)} target="_blank" rel="noreferrer">
					Open Cloud Shell
					<ExternalLinkIcon size={14} />
				</a>
			}
		/>
	)
}

function ScriptBlock({ script, label, secret = false }: { script: string; label: string; secret?: boolean }) {
	return (
		<div className="overflow-hidden rounded-md border border-border bg-muted">
			<div className="flex items-center justify-between py-1 pr-1.5 pl-3">
				<Eyebrow>bash</Eyebrow>
				<CopyButton value={script} label={label} idleLabel="Copy" />
			</div>
			{/* The dashboard records itself with rrweb, which serializes plain text verbatim. */}
			<pre
				className={cn(
					"max-h-80 overflow-auto bg-background/50 p-3 font-mono text-xs leading-relaxed",
					secret && REPLAY_BLOCK_CLASS,
				)}
			>
				{script}
			</pre>
		</div>
	)
}

function GcpProjectForm({
	onCreated,
	onCancel,
}: {
	onCreated: (connector: V2GcpConnector) => void
	onCancel?: () => void
}) {
	const create = useAtomSet(MapleApiV2AtomClient.mutation("gcpIntegration", "createConnector"), {
		mode: "promiseExit",
	})
	const [value, setValue] = useState("")
	const [error, setError] = useState<string | null>(null)

	// The API validates with the same schema, so a rejected ID is caught before the request.
	const projectId = decodeProjectId(value.trim())
	const invalid = value.trim().length > 0 && Option.isNone(projectId)

	const [submit, submitting] = useAsyncAction(async () => {
		if (Option.isNone(projectId)) return
		setError(null)
		const result = await create({
			payload: { project_id: projectId.value },
			reactivityKeys: REACTIVITY_KEYS,
		})
		if (Exit.isSuccess(result)) {
			onCreated(result.value)
			return
		}
		// An already-connected project answers with a message naming it; keep that on screen.
		setError(errorMessage(result, "Couldn't connect the project. Check the project ID and try again."))
	})

	function handleSubmit(event: React.FormEvent) {
		event.preventDefault()
		void submit()
	}

	return (
		<form onSubmit={handleSubmit} className="flex w-full flex-col gap-2 text-left">
			<Field className="items-stretch gap-2" invalid={invalid || error !== null}>
				<FieldLabel htmlFor="gcp-project-id">Project ID</FieldLabel>
				<div className="flex flex-wrap items-center gap-2">
					<Input
						id="gcp-project-id"
						autoComplete="off"
						spellCheck={false}
						placeholder="acme-prod"
						value={value}
						onChange={(event) => {
							setValue(event.target.value)
							setError(null)
						}}
						className="min-w-48 flex-1 font-mono"
					/>
					{onCancel !== undefined ? (
						<Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
							Cancel
						</Button>
					) : null}
					<Button type="submit" disabled={Option.isNone(projectId)} loading={submitting}>
						Add project
					</Button>
				</div>
				{error !== null ? (
					<FieldError match role="alert">
						{error}
					</FieldError>
				) : invalid ? (
					<FieldError match>
						A project ID is 6 to 30 lowercase letters, digits and hyphens, and starts with a
						letter. The project name and number don&apos;t work.
					</FieldError>
				) : (
					<FieldDescription>
						Shown next to the project name in the Google Cloud console&apos;s project picker.
					</FieldDescription>
				)}
			</Field>
		</form>
	)
}

function SetupStep({
	number,
	title,
	children,
}: {
	number: number
	title: string
	children: React.ReactNode
}) {
	return (
		<li className="flex gap-3">
			<span
				aria-hidden
				className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full bg-primary text-4xs font-medium text-primary-foreground"
			>
				{number}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<span className="text-xs font-medium">{title}</span>
				{children}
			</div>
		</li>
	)
}

/** Admin-only: fetching the script is refused for everyone else, and it carries the secret. */
function GcpSetupPanel({
	connector,
	metricsAvailable,
}: {
	connector: V2GcpConnector
	metricsAvailable: boolean
}) {
	const [excludeGke, setExcludeGke] = useState(false)
	// A bare query on purpose. `retainedQueryV2` keeps results past unmount, and this one embeds
	// the connector's secret: it should live only while the panel is open.
	const scriptsQuery = MapleApiV2AtomClient.query("gcpIntegration", "setupScripts", {
		params: { id: connector.id },
		payload: { exclude_gke_container_logs: excludeGke },
	})
	const scriptsResult = useAtomValue(scriptsQuery)
	const retry = useAtomRefresh(scriptsQuery)
	// `waiting` is the previous toggle's script held over while the new one loads. Copying that
	// would install the wrong filter, so only a settled result is shown.
	const script =
		Result.isSuccess(scriptsResult) && !scriptsResult.waiting ? scriptsResult.value.setup_script : null

	return (
		<ol className="flex flex-col gap-4 border-t border-border/60 bg-muted/20 p-4">
			<SetupStep number={1} title="Open Cloud Shell">
				<p className="text-xs text-muted-foreground">
					Sign in with an account that owns <InlineCode>{connector.project_id}</InlineCode>.
				</p>
				<div>
					<OpenCloudShellButton projectId={connector.project_id} />
				</div>
			</SetupStep>
			<SetupStep number={2} title="Paste and run the script">
				<p className="text-xs text-muted-foreground">
					It creates a log sink, a Pub/Sub topic and a push subscription to Maple
					{metricsAvailable ? ", plus a read-only service account for metrics" : ""}. Running it
					again is safe.
				</p>
				<SettingRow
					framed
					label="Exclude GKE container logs"
					description="Turn on if your pods already send their logs to Maple through an OpenTelemetry collector."
					control={<Switch checked={excludeGke} onCheckedChange={setExcludeGke} />}
				/>
				{script !== null ? (
					<ScriptBlock script={script} label="Setup script" secret />
				) : Result.isFailure(scriptsResult) ? (
					<div className="flex flex-wrap items-center gap-2">
						<p className="text-xs text-severity-error" role="alert">
							{errorMessage(scriptsResult.cause, "Couldn't load the setup script.")}
						</p>
						<Button size="sm" variant="outline" onClick={retry}>
							Try again
						</Button>
					</div>
				) : (
					<Skeleton className="h-40 w-full" />
				)}
				<Alert variant="warn" size="sm">
					<CircleWarningIcon size={14} />
					<AlertDescription>
						The script contains this connector&apos;s secret. Don&apos;t share it or commit it.
					</AlertDescription>
				</Alert>
				<p className="text-xs text-muted-foreground">
					To change which logs are forwarded, edit <InlineCode>LOG_FILTER</InlineCode> at the top of
					the script and run it again.
				</p>
			</SetupStep>
			<SetupStep number={3} title="Return here">
				<p className="text-xs text-muted-foreground">
					The status changes to Receiving logs within a few minutes. This page updates on its own.
				</p>
			</SetupStep>
		</ol>
	)
}

function GcpConnectorRow({
	connector,
	metricsAvailable,
	isAdmin,
	setupOpen,
	onToggleSetup,
	onRemoved,
}: {
	connector: V2GcpConnector
	metricsAvailable: boolean
	isAdmin: boolean
	setupOpen: boolean
	onToggleSetup: () => void
	onRemoved: (removed: RemovedProject) => void
}) {
	const remove = useAtomSet(MapleApiV2AtomClient.mutation("gcpIntegration", "deleteConnector"), {
		mode: "promiseExit",
	})
	const [confirmOpen, setConfirmOpen] = useState(false)
	const state = gcpConnectorState(connector)

	// Resolving to `false` keeps the confirm dialog open for a retry.
	async function handleDisconnect() {
		const result = await remove({ params: { id: connector.id }, reactivityKeys: REACTIVITY_KEYS })
		if (Exit.isSuccess(result)) {
			onRemoved({ projectId: connector.project_id, cleanupScript: result.value.cleanup_script })
			return true
		}
		showErrorToast(result, { title: "Failed to disconnect the project" })
		return false
	}

	return (
		<div className="border-t border-border/60">
			<div className="flex flex-wrap items-center gap-3 px-4 py-3">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="truncate font-mono text-sm">{connector.project_id}</span>
					<span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
						<StatusDot
							tone={
								state.kind === "receiving"
									? "ok"
									: state.kind === "error"
										? "crit"
										: "neutral"
							}
						/>
						{state.kind === "waiting" ? (
							"Waiting for the first log"
						) : (
							<>
								<span className="text-foreground">
									{state.kind === "receiving" ? "Receiving logs" : "Last push rejected"}
								</span>
								{state.lastLogReceivedAt !== null ? (
									<>
										{"· "}
										<RelativeTime
											value={state.lastLogReceivedAt}
											prefix={
												state.kind === "receiving" ? "last log" : "last accepted log"
											}
										/>
									</>
								) : null}
							</>
						)}
					</span>
				</div>
				{isAdmin ? (
					<div className="flex shrink-0 items-center gap-1.5">
						<Button size="sm" variant="outline" onClick={onToggleSetup}>
							{setupOpen ? "Hide setup" : "Show setup"}
						</Button>
						<Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)}>
							Disconnect
						</Button>
					</div>
				) : null}
			</div>
			{state.kind === "error" ? (
				<p className="mx-4 mb-3 break-all rounded-md bg-muted/40 p-2 font-mono text-xs text-severity-error">
					{state.error}
				</p>
			) : null}
			{setupOpen ? <GcpSetupPanel connector={connector} metricsAvailable={metricsAvailable} /> : null}
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={`Disconnect ${connector.project_id}?`}
				description="Maple stops accepting this project's logs immediately. What the setup script created stays in Google Cloud until you run the cleanup script, which is shown after you disconnect."
				confirmLabel="Disconnect"
				onConfirm={handleDisconnect}
			/>
		</div>
	)
}

/**
 * Google Cloud connection card. No OAuth: an admin registers a connector per project and runs
 * the generated script in Cloud Shell, so the card is a project list with a setup panel and a
 * status line each. Everyone else sees the list and the status only.
 */
export function GcpIntegrationCard() {
	const statusQuery = gcpStatusQuery()
	const statusResult = useAtomValue(statusQuery)
	const refreshStatus = useAtomRefresh(statusQuery)

	// The gate the API applies. `useIsOrgAdmin` is false until the session lands, so the
	// admin-only note waits for a settled session; the controls stay hidden meanwhile.
	const isAdmin = useIsOrgAdmin()
	const sessionResult = useAtomValue(retainedQuery("auth", "session", {}))
	const showNotAdmin = !isAdmin && (!isClerkAuthEnabled || !Result.isInitial(sessionResult))

	const [setupFor, setSetupFor] = useState<V2GcpConnector["id"] | null>(null)
	const [adding, setAdding] = useState(false)
	const [removed, setRemoved] = useState<RemovedProject | null>(null)

	// Keep the last loaded status if a poll fails.
	const status = Option.getOrNull(AsyncResult.value(statusResult))
	const connectors = status?.connectors ?? []

	const waiting = connectors.some((connector) => gcpConnectorState(connector).kind === "waiting")
	useIntervalRefresh(refreshStatus, { intervalMs: WAITING_REFRESH_MS, enabled: waiting })

	if (Result.isInitial(statusResult) && status === null) {
		return <Skeleton className="h-40 w-full rounded-lg" />
	}
	if (status === null) {
		return (
			<ErrorState
				error={Result.isFailure(statusResult) ? statusResult.cause : undefined}
				title="Failed to load the Google Cloud integration"
				onRetry={refreshStatus}
			/>
		)
	}

	function handleCreated(connector: V2GcpConnector) {
		setAdding(false)
		setSetupFor(connector.id)
	}

	const cleanup =
		removed !== null ? (
			<Panel padded className="gap-3">
				<div className="flex flex-col gap-1">
					<h3 className="text-sm font-semibold">
						<span className="font-mono">{removed.projectId}</span> disconnected
					</h3>
					<p className="text-xs text-muted-foreground">
						Maple no longer accepts this project&apos;s logs. Run this script in Cloud Shell to
						remove what the setup script created. Copy it before you leave: it isn&apos;t shown
						again.
					</p>
				</div>
				<ScriptBlock script={removed.cleanupScript} label="Cleanup script" />
				<div className="flex flex-wrap gap-2">
					<OpenCloudShellButton projectId={removed.projectId} />
					<Button size="sm" variant="outline" onClick={() => setRemoved(null)}>
						Done
					</Button>
				</div>
			</Panel>
		) : null

	const metricsNote = status.metrics_available ? " The same script also sets up metrics." : ""

	if (connectors.length === 0) {
		return (
			<div className="flex flex-col gap-4">
				{cleanup}
				<IntegrationEmpty icon={GoogleCloudIcon} backerIcon={GoogleCloudMonoIcon} accent={GCP_ACCENT}>
					<IntegrationEmptyFeatures>
						<IntegrationEmptyFeature
							label="Logs"
							title="Every service in the project"
							description="Cloud Run, GKE, Cloud SQL and audit logs arrive through one log sink."
						/>
						<IntegrationEmptyFeature
							label="Setup"
							title="One script in Cloud Shell"
							description="No OAuth and no keys to paste. Maple gets no write access to your project."
						/>
						<IntegrationEmptyFeature
							label="Projects"
							title="Connect several"
							description="Each project gets its own connector, secret and status."
						/>
					</IntegrationEmptyFeatures>
					<IntegrationEmptyCard>
						<IntegrationEmptyMedia />
						<IntegrationEmptyHint>
							Add a project to get its setup script. Logs arrive a few minutes after you run it.
							{metricsNote}
						</IntegrationEmptyHint>
						{isAdmin ? (
							<div className="w-full max-w-md">
								<GcpProjectForm onCreated={handleCreated} />
							</div>
						) : showNotAdmin ? (
							<IntegrationEmptyFooter>
								Only organization admins can connect Google Cloud projects.
							</IntegrationEmptyFooter>
						) : null}
					</IntegrationEmptyCard>
				</IntegrationEmpty>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			{cleanup}
			<Panel>
				<Item className="items-start gap-3 rounded-none p-4">
					<ItemMedia>
						<IntegrationIconPlate icon={GoogleCloudIcon} accent={GCP_ACCENT} />
					</ItemMedia>
					<ItemContent className="gap-0">
						<h3 className="text-sm font-semibold">Google Cloud</h3>
						<p className="mt-1 text-xs text-muted-foreground">
							Each project sends its logs to Maple through a log sink and Pub/Sub.{metricsNote}
						</p>
					</ItemContent>
					{isAdmin && !adding ? (
						<ItemActions className="shrink-0">
							<Button size="sm" variant="outline" onClick={() => setAdding(true)}>
								Add project
							</Button>
						</ItemActions>
					) : null}
				</Item>
				{adding ? (
					<div className="border-t border-border/60 p-4">
						<GcpProjectForm onCreated={handleCreated} onCancel={() => setAdding(false)} />
					</div>
				) : null}
				{connectors.map((connector) => (
					<GcpConnectorRow
						key={connector.id}
						connector={connector}
						metricsAvailable={status.metrics_available}
						isAdmin={isAdmin}
						setupOpen={setupFor === connector.id}
						onToggleSetup={() => setSetupFor(setupFor === connector.id ? null : connector.id)}
						onRemoved={setRemoved}
					/>
				))}
			</Panel>
			{showNotAdmin ? (
				<p className="text-2xs text-muted-foreground">
					Only organization admins can add, set up or disconnect projects.
				</p>
			) : null}
		</div>
	)
}
