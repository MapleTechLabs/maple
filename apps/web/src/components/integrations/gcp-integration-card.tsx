import { useState } from "react"
import type React from "react"
import { Exit, Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import type { GcpScopeType } from "@maple/domain/primitives"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
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
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { ErrorState } from "@/components/common/error-state"
import { OptionCard } from "@/components/common/option-card"
import { RelativeTime } from "@/components/common/relative-time"
import { REPLAY_BLOCK_CLASS } from "@/components/common/replay-privacy"
import {
	CircleInfoIcon,
	CircleWarningIcon,
	ExternalLinkIcon,
	GoogleCloudIcon,
	GoogleCloudMonoIcon,
} from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { errorMessage, showErrorToast } from "@/lib/error-toast"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	GCP_SCOPE_NAMES,
	cloudShellUrl,
	gcpAttention,
	gcpCreateRequest,
	gcpLogState,
	gcpMetricsState,
	gcpScopeLabel,
	gcpSwitchLock,
	isGcpProjectId,
	isGcpResourceNumber,
	type GcpConnectorDraft,
	type GcpFlags,
	type GcpSwitchLock,
} from "./gcp-connector-state"
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
/** Invalidated by a switch change: the script depends on what the connector has switched on. */
const SCRIPT_REACTIVITY_KEYS = ["gcpSetupScripts"]

/** Fast enough to watch the first log or metrics land, or an error clear after a re-run. */
const SETTLING_REFRESH_MS = 10_000
/** Keeps the "last log" and "last read" times and a new error current on a page left open. */
const STEADY_REFRESH_MS = 60_000

const PROJECT_ID_RULE =
	"A project ID is 6 to 30 lowercase letters, digits and hyphens. It starts with a letter and can't end with a hyphen. The project name and number don't work."

/** The add form's scope choices, in display order. `runAs` mirrors the setup script's header. */
const SCOPES = {
	organization: {
		description: "Every project in the organization, including ones created later.",
		idLabel: "Organization ID",
		idRule: "An organization ID is digits only, such as 123456789012.",
		runAs: "Logs Configuration Writer and Organization Administrator on the organization",
	},
	folder: {
		description: "Every project in the folder, including ones created later.",
		idLabel: "Folder ID",
		idRule: "A folder ID is digits only, such as 123456789012.",
		runAs: "Logs Configuration Writer and Folder IAM Admin on the folder",
	},
	project: {
		description: "One project.",
		idLabel: "Project ID",
		idRule: PROJECT_ID_RULE,
		runAs: null,
	},
} as const
const SCOPE_TYPES: ReadonlyArray<GcpScopeType> = ["organization", "folder", "project"]

const LOCK_NOTES = {
	"last-on": "This is all this connection collects. To stop it, disconnect.",
	"metrics-unavailable": "Not available on this Maple deployment.",
} as const satisfies { readonly [Lock in GcpSwitchLock]: string }

/** A disconnected scope's cleanup script, shown until dismissed. It carries no secret. */
interface RemovedConnector {
	readonly id: V2GcpConnector["id"]
	readonly label: string
	readonly hostProjectId: string
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

function GcpConnectForm({
	metricsAvailable,
	onCreated,
	onCancel,
}: {
	metricsAvailable: boolean
	onCreated: (connector: V2GcpConnector) => void
	onCancel?: () => void
}) {
	const create = useAtomSet(MapleApiV2AtomClient.mutation("gcpIntegration", "createConnector"), {
		mode: "promiseExit",
	})
	const [draft, setDraft] = useState<GcpConnectorDraft>({
		scopeType: "project",
		scopeId: "",
		hostProjectId: "",
		logsEnabled: true,
		metricsEnabled: false,
	})
	const [error, setError] = useState<string | null>(null)
	// A rule turns red once its field was left, not while the first characters are being typed.
	const [touched, setTouched] = useState({ scopeId: false, hostProjectId: false })

	const scope = SCOPES[draft.scopeType]
	const aggregated = draft.scopeType !== "project"
	// Decoded with the API's own schema, so a rejected ID is caught before the request.
	const request = gcpCreateRequest(draft)
	const scopeId = draft.scopeId.trim()
	const hostProjectId = draft.hostProjectId.trim()
	const scopeIdInvalid =
		touched.scopeId &&
		scopeId.length > 0 &&
		!(aggregated ? isGcpResourceNumber(scopeId) : isGcpProjectId(scopeId))
	const hostInvalid =
		touched.hostProjectId && aggregated && hostProjectId.length > 0 && !isGcpProjectId(hostProjectId)

	const edit = (patch: Partial<GcpConnectorDraft>) => {
		setDraft({ ...draft, ...patch })
		setError(null)
	}

	const [submit, submitting] = useAsyncAction(async () => {
		if (Option.isNone(request)) return
		setError(null)
		// The client types the request as one object per payload variant, so the union has to be
		// narrowed before it is passed; both branches make the same call.
		const payload = request.value
		const result = await (payload.scope_type === "project"
			? create({ payload, reactivityKeys: REACTIVITY_KEYS })
			: create({ payload, reactivityKeys: REACTIVITY_KEYS }))
		if (Exit.isSuccess(result)) {
			setDraft({ ...draft, scopeId: "", hostProjectId: "" })
			onCreated(result.value)
			return
		}
		// An already-connected scope answers with a message naming it; keep that on screen.
		setError(errorMessage(result, "Couldn't connect. Try again."))
	})

	function handleSubmit(event: React.FormEvent) {
		event.preventDefault()
		void submit()
	}

	return (
		<form onSubmit={handleSubmit} className="flex w-full flex-col gap-3 text-left">
			<div
				className="grid grid-cols-1 gap-2 sm:grid-cols-3"
				role="radiogroup"
				aria-label="What to connect"
			>
				{SCOPE_TYPES.map((scopeType) => (
					<OptionCard
						key={scopeType}
						type="radio"
						name="gcp-scope-type"
						checked={draft.scopeType === scopeType}
						// The two kinds of ID never carry over, so the field starts over.
						onChange={() => {
							edit({ scopeType, scopeId: "" })
							setTouched({ ...touched, scopeId: false })
						}}
						label={GCP_SCOPE_NAMES[scopeType]}
						title={GCP_SCOPE_NAMES[scopeType]}
						description={SCOPES[scopeType].description}
					/>
				))}
			</div>
			<Field className="items-stretch gap-2" invalid={scopeIdInvalid}>
				<FieldLabel htmlFor="gcp-scope-id">{scope.idLabel}</FieldLabel>
				<Input
					id="gcp-scope-id"
					autoComplete="off"
					spellCheck={false}
					placeholder={aggregated ? "123456789012" : "acme-prod"}
					value={draft.scopeId}
					onChange={(event) => edit({ scopeId: event.target.value })}
					onBlur={() => setTouched({ ...touched, scopeId: true })}
					className="font-mono"
				/>
				{scopeIdInvalid ? <FieldError match>{scope.idRule}</FieldError> : null}
			</Field>
			{aggregated ? (
				<Field className="items-stretch gap-2" invalid={hostInvalid}>
					<FieldLabel htmlFor="gcp-host-project-id">Host project ID</FieldLabel>
					<Input
						id="gcp-host-project-id"
						autoComplete="off"
						spellCheck={false}
						placeholder="acme-observability"
						value={draft.hostProjectId}
						onChange={(event) => edit({ hostProjectId: event.target.value })}
						onBlur={() => setTouched({ ...touched, hostProjectId: true })}
						className="font-mono"
					/>
					{hostInvalid ? (
						<FieldError match>{PROJECT_ID_RULE}</FieldError>
					) : (
						<FieldDescription>
							The project where Maple&apos;s service account and Pub/Sub topic are created.
						</FieldDescription>
					)}
				</Field>
			) : null}
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-2 text-sm font-medium">What to collect</legend>
				<Field className="flex-row items-center gap-2">
					<Checkbox
						id="gcp-logs-enabled"
						checked={draft.logsEnabled}
						onCheckedChange={(checked) => edit({ logsEnabled: checked === true })}
					/>
					<FieldLabel htmlFor="gcp-logs-enabled" className="font-normal">
						Log forwarding
					</FieldLabel>
				</Field>
				<Field className="flex-row flex-wrap items-center gap-2" disabled={!metricsAvailable}>
					<Checkbox
						id="gcp-metrics-enabled"
						checked={draft.metricsEnabled}
						disabled={!metricsAvailable}
						onCheckedChange={(checked) => edit({ metricsEnabled: checked === true })}
					/>
					<FieldLabel htmlFor="gcp-metrics-enabled" className="font-normal">
						Metrics and resources
					</FieldLabel>
					{metricsAvailable ? null : (
						<FieldDescription>{LOCK_NOTES["metrics-unavailable"]}</FieldDescription>
					)}
				</Field>
				{draft.logsEnabled || draft.metricsEnabled ? null : (
					<p className="text-xs text-destructive-foreground">Choose at least one.</p>
				)}
			</fieldset>
			{error !== null ? (
				<p className="text-xs text-destructive-foreground" role="alert">
					{error}
				</p>
			) : null}
			<div className="flex justify-end gap-2">
				{onCancel !== undefined ? (
					<Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
						Cancel
					</Button>
				) : null}
				<Button type="submit" disabled={Option.isNone(request)} loading={submitting}>
					Connect
				</Button>
			</div>
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
function GcpSetup({
	connector,
	flags,
	rerun,
}: {
	connector: V2GcpConnector
	flags: GcpFlags
	/** A switch was just saved: Google Cloud follows only once the script runs again. */
	rerun: boolean
}) {
	const [excludeGke, setExcludeGke] = useState(false)
	// A bare query on purpose. `retainedQueryV2` keeps results past unmount, and this one embeds
	// the connector's secret: it should live only while the panel is open.
	const scriptsQuery = MapleApiV2AtomClient.query("gcpIntegration", "setupScripts", {
		params: { id: connector.id },
		payload: { log_filter: excludeGke ? "exclude_gke_container_logs" : "default" },
		reactivityKeys: SCRIPT_REACTIVITY_KEYS,
	})
	const scriptsResult = useAtomValue(scriptsQuery)
	const retry = useAtomRefresh(scriptsQuery)
	// `waiting` is the script for the previous toggle or switch position, held over while the new
	// one loads. Copying that would set up the wrong thing, so only a settled result is shown.
	const script =
		Result.isSuccess(scriptsResult) && !scriptsResult.waiting ? scriptsResult.value.setup_script : null
	const runAs = SCOPES[connector.scope_type].runAs
	const host = <InlineCode>{connector.project_id}</InlineCode>
	const logsEnabled = flags.logs_enabled

	return (
		<div className="flex flex-col gap-4 border-t border-border/60 bg-muted/20 p-4">
			{rerun ? (
				<Alert variant="info" size="sm">
					<CircleInfoIcon size={14} />
					<AlertDescription>
						Saved. Run the script below for the change to take effect in Google Cloud.
					</AlertDescription>
				</Alert>
			) : null}
			<ol className="flex flex-col gap-4">
				<SetupStep number={1} title="Open Cloud Shell">
					<p className="text-xs text-muted-foreground">
						{runAs === null ? (
							<>Sign in as an Owner of {host}. The link opens Cloud Shell in that project.</>
						) : (
							<>
								Sign in as an Owner of the host project {host} who also has {runAs}. The link
								opens Cloud Shell in the host project.
							</>
						)}
					</p>
					<div>
						<OpenCloudShellButton projectId={connector.project_id} />
					</div>
				</SetupStep>
				<SetupStep number={2} title="Paste and run the script">
					<p className="text-xs text-muted-foreground">
						It sets up what is switched on above and removes what is switched off, so run it again
						after changing a switch. Running it twice is safe.
					</p>
					{logsEnabled ? (
						<SettingRow
							framed
							label="Exclude GKE container logs"
							description="Turn on if your pods already send their logs to Maple through an OpenTelemetry collector."
							control={
								<Switch
									aria-label="Exclude GKE container logs"
									checked={excludeGke}
									onCheckedChange={setExcludeGke}
								/>
							}
						/>
					) : null}
					{script !== null ? (
						<ScriptBlock script={script} label="Setup script" secret />
					) : Result.isFailure(scriptsResult) ? (
						<div className="flex flex-wrap items-center gap-2">
							<p className="text-xs text-severity-error" role="alert">
								{errorMessage(scriptsResult.cause, "Couldn't load the setup script.")}
							</p>
							<Button
								size="sm"
								variant="outline"
								onClick={retry}
								loading={scriptsResult.waiting}
							>
								Try again
							</Button>
						</div>
					) : (
						<Skeleton className="h-40 w-full" />
					)}
					{logsEnabled ? (
						<>
							<Alert variant="warn" size="sm">
								<CircleWarningIcon size={14} />
								<AlertDescription>
									The script contains a secret that lets anyone send logs to your Maple
									organization. Don&apos;t share it or commit it. If it leaks, disconnect
									and connect again.
								</AlertDescription>
							</Alert>
							<p className="text-xs text-muted-foreground">
								By default it leaves out Data Access audit logs and load balancer health
								checks. To change which logs are forwarded, edit{" "}
								<InlineCode>LOG_FILTER</InlineCode> at the top of the script and run it again.
								Keep your edited copy: a script copied from here starts from the default
								filter.
							</p>
						</>
					) : null}
				</SetupStep>
				<SetupStep number={3} title="Return here">
					<p className="text-xs text-muted-foreground">
						{logsEnabled ? "Log forwarding changes to Receiving logs within a few minutes. " : ""}
						{flags.metrics_enabled
							? "Metrics appear within about ten minutes: Maple reads them every five minutes, five minutes behind. "
							: ""}
						This page updates on its own.
					</p>
				</SetupStep>
			</ol>
		</div>
	)
}

/**
 * One thing a connector collects: its name, what it is doing, its switch. Each is a
 * self-contained row under the connector header.
 */
function Capability({
	title,
	control,
	lock,
	children,
}: {
	title: string
	/** The switch; absent for non-admins, who read the state from `children`. */
	control: React.ReactNode
	lock: GcpSwitchLock | null
	children: React.ReactNode
}) {
	return (
		<section className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3">
			<h4 className="w-40 shrink-0 text-xs font-medium">{title}</h4>
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
				{children}
			</div>
			{control}
			{control !== null && lock !== null ? (
				<p className="basis-full text-right text-2xs text-muted-foreground">{LOCK_NOTES[lock]}</p>
			) : null}
		</section>
	)
}

/** A capability's status: dot, headline, when it last delivered, and what the API said about it. */
function Status({
	tone,
	label,
	at,
	atPrefix,
	suffix,
	detail,
}: {
	tone: "ok" | "crit" | "neutral"
	label: string
	at?: string | null
	atPrefix?: string
	suffix?: string | null
	/** The API's own words. Red only when the capability is failing. */
	detail?: string | null
}) {
	return (
		<>
			<StatusDot tone={tone} />
			<span className={tone === "neutral" ? undefined : "text-foreground"}>{label}</span>
			{at ? (
				<>
					{"· "}
					<RelativeTime value={at} prefix={atPrefix} />
				</>
			) : null}
			{suffix ? `· ${suffix}` : null}
			{detail ? (
				<p
					className={cn(
						"basis-full break-all rounded-md bg-muted/40 p-2 font-mono",
						tone === "crit" && "text-severity-error",
					)}
				>
					{detail}
				</p>
			) : null}
		</>
	)
}

const OFF = <span className="text-foreground">Off</span>

function LogStatus({ connector, logsEnabled }: { connector: V2GcpConnector; logsEnabled: boolean }) {
	const state = gcpLogState({ ...connector, logs_enabled: logsEnabled })
	switch (state.kind) {
		case "off":
			return OFF
		case "waiting":
			return <Status tone="neutral" label="Waiting for the first log" />
		case "receiving":
			return (
				<Status tone="ok" label="Receiving logs" at={state.lastLogReceivedAt} atPrefix="last log" />
			)
		case "error":
			return (
				<Status
					tone="crit"
					label="Last push rejected"
					at={state.lastLogReceivedAt}
					atPrefix="last accepted log"
					detail={state.error}
				/>
			)
	}
}

function MetricsStatus({
	connector,
	metricsEnabled,
}: {
	connector: V2GcpConnector
	metricsEnabled: boolean
}) {
	const state = gcpMetricsState({ ...connector, metrics_enabled: metricsEnabled })
	switch (state.kind) {
		case "off":
			return OFF
		case "waiting":
			return <Status tone="neutral" label="Waiting for the first metrics" detail={state.note} />
		case "receiving":
			return (
				<Status
					tone="ok"
					label="Receiving metrics"
					at={state.lastMetricsReceivedAt}
					atPrefix="last read"
					suffix={state.projectCount === null ? null : countLabel(state.projectCount, "project")}
					detail={
						state.resourcesError === null ? null : `Resource inventory: ${state.resourcesError}`
					}
				/>
			)
		case "error":
			return (
				<Status
					tone="crit"
					label="Last read failed or was incomplete"
					at={state.lastMetricsReceivedAt}
					atPrefix="last read"
					detail={state.error}
				/>
			)
	}
}

function GcpConnectorRow({
	connector,
	metricsAvailable,
	isAdmin,
	setupOpen,
	onSetupOpenChange,
	onRemoved,
}: {
	connector: V2GcpConnector
	metricsAvailable: boolean
	isAdmin: boolean
	setupOpen: boolean
	onSetupOpenChange: (open: boolean) => void
	onRemoved: (removed: RemovedConnector) => void
}) {
	// One atom for every row, running one call at a time: a second save would cancel the first.
	// So `updating` disables the switches of every connector while any save is in flight.
	const updateAtom = MapleApiV2AtomClient.mutation("gcpIntegration", "updateConnector")
	const update = useAtomSet(updateAtom, { mode: "promiseExit" })
	const updating = useAtomValue(updateAtom).waiting
	const remove = useAtomSet(MapleApiV2AtomClient.mutation("gcpIntegration", "deleteConnector"), {
		mode: "promiseExit",
	})
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [rerun, setRerun] = useState(false)
	// What a switch was just set to, shown until the status read delivers a newer connector. Without
	// it a saved switch snaps back for the length of the refetch.
	const [asked, setAsked] = useState<{ readonly of: V2GcpConnector; readonly flags: GcpFlags } | null>(null)
	const flags: GcpFlags = asked !== null && asked.of === connector ? asked.flags : connector
	const label = gcpScopeLabel(connector)

	// Only the flipped switch is sent: the API leaves an omitted one as it is, so a stale view of
	// the other cannot overwrite it.
	async function save(patch: Partial<GcpFlags>) {
		setAsked({ of: connector, flags: { ...flags, ...patch } })
		const result = await update({
			params: { id: connector.id },
			payload: patch,
			reactivityKeys: [...REACTIVITY_KEYS, ...SCRIPT_REACTIVITY_KEYS],
		})
		if (Exit.isSuccess(result)) {
			setRerun(true)
			onSetupOpenChange(true)
			return
		}
		setAsked(null)
		showErrorToast(result, { title: "Failed to save the change" })
	}

	// Resolving to `false` keeps the confirm dialog open for a retry.
	async function handleDisconnect() {
		const result = await remove({ params: { id: connector.id }, reactivityKeys: REACTIVITY_KEYS })
		if (Exit.isSuccess(result)) {
			onRemoved({
				id: connector.id,
				label,
				hostProjectId: connector.project_id,
				cleanupScript: result.value.cleanup_script,
			})
			return true
		}
		showErrorToast(result, { title: "Failed to disconnect" })
		return false
	}

	const logsLock = gcpSwitchLock(flags, "logs", metricsAvailable)
	const metricsLock = gcpSwitchLock(flags, "metrics", metricsAvailable)

	return (
		<div className="border-t border-border/60">
			<div className="flex flex-wrap items-center gap-3 px-4 pt-3 pb-2">
				<div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-sm">
					<span className="font-medium">{label}</span>
					{connector.scope_type !== "project" ? (
						<span className="text-xs text-muted-foreground">
							host project <span className="font-mono">{connector.project_id}</span>
						</span>
					) : null}
				</div>
				{isAdmin ? (
					<div className="flex shrink-0 items-center gap-1.5">
						<Button size="sm" variant="outline" onClick={() => onSetupOpenChange(!setupOpen)}>
							{setupOpen ? "Hide setup" : "Show setup"}
						</Button>
						<Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)}>
							Disconnect
						</Button>
					</div>
				) : null}
			</div>
			<Capability
				title="Log forwarding"
				lock={logsLock}
				control={
					isAdmin ? (
						<Switch
							aria-label="Log forwarding"
							checked={flags.logs_enabled}
							disabled={updating || logsLock !== null}
							onCheckedChange={(logs_enabled) => void save({ logs_enabled })}
						/>
					) : null
				}
			>
				<LogStatus connector={connector} logsEnabled={flags.logs_enabled} />
			</Capability>
			<Capability
				title="Metrics and resources"
				lock={metricsLock}
				control={
					isAdmin ? (
						<Switch
							aria-label="Metrics and resources"
							checked={flags.metrics_enabled}
							disabled={updating || metricsLock !== null}
							onCheckedChange={(metrics_enabled) => void save({ metrics_enabled })}
						/>
					) : null
				}
			>
				<MetricsStatus connector={connector} metricsEnabled={flags.metrics_enabled} />
			</Capability>
			{setupOpen ? <GcpSetup connector={connector} flags={flags} rerun={rerun} /> : null}
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={`Disconnect ${label}?`}
				description="Maple stops accepting its logs and reading its metrics and resources. Data already in Maple is kept. What the setup script created stays in Google Cloud, and logs keep being sent, until you run the cleanup script, shown after you disconnect."
				confirmLabel="Disconnect"
				onConfirm={handleDisconnect}
			/>
		</div>
	)
}

/**
 * Google Cloud connection card. No OAuth: an admin registers a connector for a project, folder or
 * organization and runs the generated script in Cloud Shell. The card lists the connectors, each
 * with a switch per thing it collects and one setup panel. Everyone else sees the list and the
 * status only.
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

	const [setupFor, setSetupFor] = useState<V2GcpConnector["id"] | null>(null)
	const [adding, setAdding] = useState(false)
	const [removed, setRemoved] = useState<ReadonlyArray<RemovedConnector>>([])

	// Keep the last loaded status if a poll fails.
	const status = Option.getOrNull(AsyncResult.value(statusResult))
	const connectors = status?.connectors ?? []

	const settling = connectors.some((connector) => gcpAttention(connector) !== null)
	useIntervalRefresh(refreshStatus, {
		intervalMs: settling ? SETTLING_REFRESH_MS : STEADY_REFRESH_MS,
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

	function handleCreated(connector: V2GcpConnector) {
		setAdding(false)
		setSetupFor(connector.id)
	}

	const cleanup = removed.map((entry) => (
		<Panel key={entry.id} padded className="gap-3">
			<div className="flex flex-col gap-1">
				<h3 className="text-sm font-semibold">{entry.label} disconnected</h3>
				<p className="text-xs text-muted-foreground">
					Maple no longer accepts its logs or reads its metrics. Run this script in Cloud Shell to
					remove what the setup script created. Copy it before you leave: it isn&apos;t shown again.
				</p>
			</div>
			<ScriptBlock script={entry.cleanupScript} label="Cleanup script" />
			<div className="flex flex-wrap gap-2">
				<OpenCloudShellButton projectId={entry.hostProjectId} />
				<Button
					size="sm"
					variant="outline"
					onClick={() => setRemoved((current) => current.filter((other) => other.id !== entry.id))}
				>
					Done
				</Button>
			</div>
		</Panel>
	))

	if (connectors.length === 0) {
		return (
			<div className="flex flex-col gap-4">
				{cleanup}
				<IntegrationEmpty icon={GoogleCloudIcon} backerIcon={GoogleCloudMonoIcon} accent={GCP_ACCENT}>
					<IntegrationEmptyFeatures>
						<IntegrationEmptyFeature
							label="Scope"
							title="Organization, folder or project"
							description="An organization or folder covers every project under it, including ones created later."
						/>
						<IntegrationEmptyFeature
							label="Logs"
							title="One log sink"
							description="Cloud Run, GKE, Cloud SQL and the rest of Cloud Logging arrive through it."
						/>
						<IntegrationEmptyFeature
							label="Setup"
							title="One script in Cloud Shell"
							description="No OAuth and no service account keys. Maple gets no write access to Google Cloud."
						/>
					</IntegrationEmptyFeatures>
					<IntegrationEmptyCard>
						<IntegrationEmptyMedia />
						<IntegrationEmptyHint>
							{isAdmin
								? "Choose what to connect to get its setup script. After you run it, logs arrive within a few minutes and metrics within about ten."
								: "After an admin connects Google Cloud and runs the setup script, logs arrive within a few minutes and metrics within about ten."}
						</IntegrationEmptyHint>
						{isAdmin ? (
							<div className="w-full max-w-2xl">
								<GcpConnectForm
									metricsAvailable={status?.metrics_available === true}
									onCreated={handleCreated}
								/>
							</div>
						) : showNotAdmin ? (
							<IntegrationEmptyFooter>
								Only organization admins can connect Google Cloud.
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
							Each connection covers a project, a folder or an organization. A switch change
							takes effect in Google Cloud once its setup script is run again.
						</p>
					</ItemContent>
					{isAdmin && !adding ? (
						<ItemActions className="shrink-0">
							<Button size="sm" variant="outline" onClick={() => setAdding(true)}>
								Add connection
							</Button>
						</ItemActions>
					) : null}
				</Item>
				{adding ? (
					<div className="border-t border-border/60 p-4">
						<GcpConnectForm
							metricsAvailable={status?.metrics_available === true}
							onCreated={handleCreated}
							onCancel={() => setAdding(false)}
						/>
					</div>
				) : null}
				{connectors.map((connector) => (
					<GcpConnectorRow
						key={connector.id}
						connector={connector}
						metricsAvailable={status?.metrics_available === true}
						isAdmin={isAdmin}
						setupOpen={setupFor === connector.id}
						onSetupOpenChange={(open) => setSetupFor(open ? connector.id : null)}
						onRemoved={(entry) => setRemoved((current) => [...current, entry])}
					/>
				))}
			</Panel>
			{showNotAdmin ? (
				<p className="text-2xs text-muted-foreground">
					Only organization admins can add, change or disconnect connections.
				</p>
			) : null}
		</div>
	)
}
