import { Fragment, useId, useState } from "react"
import type React from "react"
import { Link } from "@tanstack/react-router"
import { Exit, Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import type { GcpLogFilter, GcpScopeType } from "@maple/domain/primitives"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@maple/ui/components/ui/field"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Input } from "@maple/ui/components/ui/input"
import { Panel } from "@maple/ui/components/ui/panel"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Switch } from "@maple/ui/components/ui/switch"
import { countLabel } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import {
	removedGcpConnectorsAtomFamily,
	type RemovedGcpConnector,
} from "@/atoms/gcp-removed-connectors-atoms"
import { ErrorState } from "@/components/common/error-state"
import { OptionCard } from "@/components/common/option-card"
import { RelativeTime } from "@/components/common/relative-time"
import { REPLAY_BLOCK_CLASS } from "@/components/common/replay-privacy"
import {
	AlertWarningIcon,
	CircleCheckIcon,
	CircleInfoIcon,
	ExternalLinkIcon,
	GoogleCloudIcon,
	GoogleCloudMonoIcon,
} from "@/components/icons"
import { SettingsSection } from "@/components/settings/settings-section"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { useLiveClock } from "@/hooks/use-live-clock"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { docsUrl } from "@/lib/docs"
import { Result, useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { errorMessage, showErrorToast } from "@/lib/error-toast"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { getActiveOrgId } from "@/lib/services/common/auth-headers"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	GCP_CONNECTION_LABEL,
	GCP_LOG_STATUS,
	GCP_METRICS_STATUS,
	GCP_SCOPE_NAMES,
	cloudShellUrl,
	gcpConnectionState,
	gcpCreateRequest,
	gcpLogFilterChoice,
	gcpLogFilters,
	gcpLogState,
	gcpMetricsState,
	gcpOverlapNote,
	gcpPendingChanges,
	gcpScopeLabel,
	gcpScopeRoles,
	gcpScriptNeeded,
	gcpScriptOverdue,
	gcpSetupRunning,
	gcpSwitchLock,
	isGcpProjectId,
	isGcpResourceNumber,
	logRouterUrl,
	type GcpConnectorDraft,
	type GcpFlags,
	type GcpSwitchLock,
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

const REACTIVITY_KEYS = ["gcpIntegration"]
/** Invalidated by a switch change: the script depends on what the connector has switched on. */
const SCRIPT_REACTIVITY_KEYS = ["gcpSetupScripts"]

/** Fast enough to see a script run confirmed, the first data land, or an error clear. */
const SETTLING_REFRESH_MS = 10_000
/** Keeps the "last log" and "last read" times and a new error current on a page left open. */
const STEADY_REFRESH_MS = 60_000

const DOCS = docsUrl("gcp")
const OTEL_DOCS = docsUrl("gcpOpenTelemetry")
const GKE_LOGS_DOCS = `${OTEL_DOCS}#gke-container-logs`
const MANAGE_RESOURCES_URL = "https://console.cloud.google.com/cloud-resource-manager"

const PROJECT_ID_RULE =
	"A project ID is 6 to 30 lowercase letters, digits and hyphens. It starts with a letter and can't end with a hyphen. The project name and number don't work."

/** The add form's scope choices, in display order. */
const SCOPES = {
	organization: {
		description: "Every project in it, including new ones.",
		idLabel: "Organization ID",
		idRule: "An organization ID is digits only, such as 123456789012.",
		listHint: "Or run",
		listCommand: "gcloud organizations list",
	},
	folder: {
		description: "Every project in it, including new ones.",
		idLabel: "Folder ID",
		idRule: "A folder ID is digits only, such as 123456789012.",
		listHint: "Or, with your organization's ID in place of ORGANIZATION_ID, run",
		listCommand: "gcloud resource-manager folders list --organization=ORGANIZATION_ID",
	},
	project: {
		description: "One project.",
		idLabel: "Project ID",
		idRule: PROJECT_ID_RULE,
		listHint: "Or run",
		listCommand: "gcloud projects list",
	},
} as const
const SCOPE_TYPES: ReadonlyArray<GcpScopeType> = ["organization", "folder", "project"]

const LOCK_NOTES = {
	"last-on": "A connection keeps one switch on. To stop collecting, disconnect.",
	"metrics-unavailable": "Not available on this Maple deployment.",
} as const satisfies { readonly [Lock in GcpSwitchLock]: string }

/** The card's one link style, the other integrations' (Railway's token link). */
const LINK = "underline underline-offset-2 hover:no-underline"
/** No line of small print runs wider than this: 72 characters of the UI's monospace. */
const MEASURE = "max-w-[72ch]"
/** Small print on its own. */
const PROSE = `${MEASURE} text-xs/5 text-pretty text-muted-foreground`
/** Small print under a field or inside a notice, which bring their own size and colour. */
const HELP = `${MEASURE} leading-5 text-pretty`
/** A connection's, a capability's or a step's name. On a phone it grows with the controls. */
const TITLE = "text-base/6 font-medium sm:text-sm/5"

/** A named link stays on one line. A bare address may break. */
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className={cn(LINK, children !== href && "whitespace-nowrap")}
		>
			{children}
			{/* A word joiner in a no-wrap span: the icon never wraps away from the last word. */}
			<span className="whitespace-nowrap">
				{"\u2060"}
				<ExternalLinkIcon size={12} className="ml-1 inline align-[-1px]" />
			</span>
		</a>
	)
}

/** An identifier inside a sentence: mono without a chip, so punctuation sits tight against it. */
function Mono({ children }: { children: React.ReactNode }) {
	return <span className="font-mono whitespace-nowrap text-foreground">{children}</span>
}

/**
 * A shell command inside a sentence, with its own copy button. Too long for its line, it breaks
 * between its words and never inside one: a flag or a name split at a hyphen reads as another.
 */
function Command({ children }: { children: string }) {
	return (
		<span className="inline-flex max-w-full items-start gap-0.5 align-top">
			<InlineCode className="min-w-0">
				{children.split(" ").map((word, index) => (
					<Fragment key={index}>
						{index === 0 ? null : " "}
						<span className="whitespace-nowrap">{word}</span>
					</Fragment>
				))}
			</InlineCode>
			<CopyButton value={children} label="command" toast={false} iconSize={12} className="size-5" />
		</span>
	)
}

/** Filled where opening Cloud Shell is a step of its own, outlined next to a copy button. */
function OpenCloudShellButton({
	projectId,
	variant = "outline",
}: {
	projectId: string
	variant?: "default" | "outline"
}) {
	return (
		<Button
			size="sm"
			variant={variant}
			render={
				<a href={cloudShellUrl(projectId)} target="_blank" rel="noreferrer">
					Open Cloud Shell
					<ExternalLinkIcon size={14} />
				</a>
			}
		/>
	)
}

function CopyScriptButton({ script, label }: { script: string | null; label: string }) {
	return (
		<CopyButton
			value={script ?? ""}
			disabled={script === null}
			label={label}
			idleLabel={`Copy ${label}`}
			toast={false}
			variant="default"
			className="text-primary-foreground hover:text-primary-foreground"
		/>
	)
}

/**
 * A script to copy, and to read on request: both scripts are a few hundred lines, so the text
 * stays closed until asked for and then scrolls inside its box. `children` are the buttons that
 * go with the copy button, `caveat` what to know before pasting, `note` what to know when reading.
 */
function Script({
	script,
	label,
	failure,
	caveat,
	note,
	children,
}: {
	script: string | null
	label: string
	failure: { readonly message: string; readonly retry: () => void; readonly retrying: boolean } | null
	caveat: string
	note?: string
	children?: React.ReactNode
}) {
	const [shown, setShown] = useState(false)
	const text = script?.trimEnd() ?? null
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<CopyScriptButton script={script} label={label} />
				{children}
				<button
					type="button"
					aria-expanded={shown}
					onClick={() => setShown(!shown)}
					className={cn(LINK, "text-xs text-muted-foreground hover:text-foreground")}
				>
					{shown ? "Hide the script" : "Read the script"}
				</button>
			</div>
			{failure === null ? null : (
				<div className="flex flex-wrap items-center gap-2">
					<p className="text-xs text-severity-error" role="alert">
						{failure.message}
					</p>
					<Button size="sm" variant="outline" onClick={failure.retry} loading={failure.retrying}>
						Try again
					</Button>
				</div>
			)}
			<p className={PROSE}>{caveat}</p>
			{!shown || failure !== null ? null : text === null ? (
				<Skeleton className="mt-1 h-72 w-full" />
			) : (
				<>
					{/* The frame of the app's code blocks: a label strip over the text. */}
					<div className="mt-1 overflow-clip rounded-md border border-border bg-muted">
						<div className="flex items-center justify-between px-3 py-1.5">
							<Eyebrow>Bash</Eyebrow>
							<span className="text-2xs text-muted-foreground">
								{countLabel(text.split("\n").length, "line")}
							</span>
						</div>
						{/* The dashboard records itself with rrweb, which serializes plain text verbatim. */}
						<pre
							tabIndex={0}
							role="region"
							aria-label={`The ${label}`}
							className={cn(
								"max-h-103 overflow-auto bg-background/50 p-3 font-mono text-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
								REPLAY_BLOCK_CLASS,
							)}
						>
							{text}
						</pre>
					</div>
					{note === undefined ? null : <p className={cn(PROSE, "mt-2")}>{note}</p>}
				</>
			)}
		</div>
	)
}

type StepState = "current" | "pending" | "done"

/**
 * One step of a setup or cleanup: a numbered marker on a line that runs to the next step, the
 * title with what to know under it, then the controls. Only a step to act on now is bright; a
 * finished one is checked.
 */
function Step({
	number,
	state,
	title,
	detail,
	children,
}: {
	number: number
	state: StepState
	title: string
	detail?: React.ReactNode
	children?: React.ReactNode
}) {
	return (
		<li
			className={cn(
				"relative flex gap-3 before:absolute before:top-6 before:bottom-1 before:left-2.5 before:w-px before:-translate-x-1/2 before:bg-border last:pb-0 last:before:hidden",
				state === "done" ? "pb-4" : "pb-8",
			)}
		>
			{state === "done" ? (
				<CircleCheckIcon size={20} className="shrink-0 text-severity-info" aria-hidden />
			) : (
				<span
					aria-hidden
					className={cn(
						"flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs font-medium",
						state === "current"
							? "border-foreground/40 text-foreground"
							: "border-border text-muted-foreground",
					)}
				>
					{number}
				</span>
			)}
			<div className="flex min-w-0 flex-1 flex-col gap-3">
				<div className="flex flex-col gap-1">
					<h4 className={cn(TITLE, state !== "current" && "text-muted-foreground")}>{title}</h4>
					{detail === undefined ? null : (
						<p className={cn(PROSE, state === "current" && "text-foreground/80")}>{detail}</p>
					)}
				</div>
				{children}
			</div>
		</li>
	)
}

/**
 * A connector's scripts. A bare query on purpose: `retainedQueryV2` keeps results past unmount,
 * and both scripts embed the connector's secret, so they live only while they are on screen.
 */
function useGcpScripts(connector: V2GcpConnector, logFilter: GcpLogFilter) {
	const query = MapleApiV2AtomClient.query("gcpIntegration", "setupScripts", {
		params: { id: connector.id },
		payload: { log_filter: logFilter },
		reactivityKeys: SCRIPT_REACTIVITY_KEYS,
	})
	const result = useAtomValue(query)
	const retry = useAtomRefresh(query)
	return {
		// `waiting` is the script for the previous filter or switch position, held over while the
		// new one loads. Copying that would set up the wrong thing, so only a settled result counts.
		scripts: Result.isSuccess(result) && !result.waiting ? result.value : null,
		failure: Result.isFailure(result)
			? {
					message: errorMessage(result.cause, "Couldn't load the script."),
					retry,
					retrying: result.waiting,
				}
			: null,
	}
}

function GcpConnectForm({
	metricsAvailable,
	existing,
	onCreated,
	onCancel,
}: {
	metricsAvailable: boolean
	existing: ReadonlyArray<V2GcpConnector>
	onCreated: () => void
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
		metricsEnabled: metricsAvailable,
	})
	const [error, setError] = useState<string | null>(null)
	// A rule turns red once its field was left, not while the first characters are being typed.
	const [touched, setTouched] = useState({ scopeId: false, hostProjectId: false })

	const scope = SCOPES[draft.scopeType]
	const scopeName = GCP_SCOPE_NAMES[draft.scopeType].toLowerCase()
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
	const scopeRoles = gcpScopeRoles(draft.scopeType, {
		logs_enabled: draft.logsEnabled,
		metrics_enabled: draft.metricsEnabled,
	})
	const overlap = gcpOverlapNote(draft.scopeType, existing)
	const ownerOn = aggregated ? hostProjectId : scopeId

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
			onCreated()
			return
		}
		// An already-connected scope answers with a message naming it; keep that on screen.
		setError(errorMessage(result, "Couldn't connect. Try again."))
	})

	function handleSubmit(event: React.FormEvent) {
		event.preventDefault()
		if (!submitting) void submit()
	}

	return (
		<form onSubmit={handleSubmit} className="@container flex w-full flex-col gap-6 text-left">
			<fieldset className="flex flex-col gap-2">
				<legend className={cn(TITLE, "mb-2")}>What to connect</legend>
				<div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
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
			</fieldset>
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
				{scopeIdInvalid ? (
					<FieldError match className={HELP}>
						{scope.idRule}
					</FieldError>
				) : (
					<FieldDescription className={HELP}>
						<span className="block">
							{aggregated ? (
								<>
									Digits only. In the console: IAM & Admin,{" "}
									<ExternalLink href={MANAGE_RESOURCES_URL}>Manage resources</ExternalLink>
								</>
							) : (
								"The ID, not the name or number. The console's project picker lists it."
							)}
						</span>
						<span className="block">
							{scope.listHint} <Command>{scope.listCommand}</Command>
						</span>
					</FieldDescription>
				)}
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
						<FieldError match className={HELP}>
							{PROJECT_ID_RULE}
						</FieldError>
					) : (
						<FieldDescription className={HELP}>
							The project that holds Maple&apos;s Pub/Sub topic and read-only service account.
							Use a shared operations project inside the {scopeName}, with billing enabled, that
							won&apos;t be deleted.
						</FieldDescription>
					)}
				</Field>
			) : null}
			<fieldset className="flex flex-col gap-4">
				<legend className={cn(TITLE, "mb-3")}>What to collect</legend>
				<Field className="grid grid-cols-[auto_1fr] items-start gap-x-2.5 gap-y-1">
					<Checkbox
						id="gcp-logs-enabled"
						className="mt-px"
						checked={draft.logsEnabled}
						onCheckedChange={(checked) => edit({ logsEnabled: checked === true })}
					/>
					<FieldLabel htmlFor="gcp-logs-enabled">Log forwarding</FieldLabel>
					<FieldDescription className={cn(HELP, "col-start-2")}>
						A log sink sends Cloud Logging entries to Maple through Pub/Sub.{" "}
						<ExternalLink href={GKE_LOGS_DOCS}>GKE container logs</ExternalLink> are left out by
						default.
					</FieldDescription>
				</Field>
				<Field
					className="grid grid-cols-[auto_1fr] items-start gap-x-2.5 gap-y-1"
					disabled={!metricsAvailable}
				>
					<Checkbox
						id="gcp-metrics-enabled"
						className="mt-px"
						checked={draft.metricsEnabled}
						disabled={!metricsAvailable}
						onCheckedChange={(checked) => edit({ metricsEnabled: checked === true })}
					/>
					<FieldLabel htmlFor="gcp-metrics-enabled">Metrics and resources</FieldLabel>
					<FieldDescription className={cn(HELP, "col-start-2")}>
						{metricsAvailable
							? "Maple reads Cloud Monitoring every 5 minutes and lists your resources every hour, through a read-only service account."
							: LOCK_NOTES["metrics-unavailable"]}
					</FieldDescription>
				</Field>
				{draft.logsEnabled || draft.metricsEnabled ? null : (
					<p className="text-xs text-destructive-foreground" role="alert">
						Choose at least one.
					</p>
				)}
			</fieldset>
			{overlap === null ? null : (
				<Alert size="sm" role="note">
					<CircleInfoIcon size={14} />
					<AlertDescription className={HELP}>{overlap}</AlertDescription>
				</Alert>
			)}
			{error !== null ? (
				<p className="text-xs text-destructive-foreground" role="alert">
					{error}
				</p>
			) : null}
			{/* What running the script takes sits with the button that starts it. */}
			<div className="flex flex-col gap-4 border-t border-border/60 pt-4">
				<div className={cn(PROSE, "flex flex-col gap-1")}>
					<p>
						To run the script you need Owner on{" "}
						{isGcpProjectId(ownerOn) ? (
							<Mono>{ownerOn}</Mono>
						) : aggregated ? (
							"the host project"
						) : (
							"the project"
						)}
						{scopeRoles.length > 0
							? `, plus ${scopeRoles.join(" and ")} on the ${scopeName}`
							: ""}
						.{" "}
						<ExternalLink href={`${DOCS}#roles-for-running-the-script`}>
							Without Owner
						</ExternalLink>
					</p>
					<p>
						Google bills Pub/Sub and Cloud Monitoring API usage to{" "}
						{aggregated ? "the host project" : "your account"}.{" "}
						<ExternalLink href={`${DOCS}#google-cloud-costs`}>Costs</ExternalLink>
					</p>
				</div>
				<div className="flex gap-2 self-end">
					{onCancel !== undefined ? (
						<Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
							Cancel
						</Button>
					) : null}
					<Button type="submit" disabled={Option.isNone(request)} loading={submitting}>
						Get setup script
					</Button>
				</div>
			</div>
		</form>
	)
}

/**
 * Stands where the script would be until the admin confirms that GKE container logs should be
 * forwarded. Not remembered: choosing the filter again asks again.
 */
function GkeContainerLogsAcknowledgement({
	backLabel,
	onConfirm,
	onBack,
}: {
	backLabel: string
	onConfirm: () => void
	onBack: () => void
}) {
	const [understood, setUnderstood] = useState(false)
	const checkboxId = useId()
	return (
		<Alert variant="warn" size="sm">
			<AlertWarningIcon size={14} />
			<AlertTitle>Not recommended when your GKE workloads send traces to Maple</AlertTitle>
			<AlertDescription className={cn(HELP, "gap-3")}>
				<p>
					Instrumented workloads already send their logs to Maple, linked to their traces.
					Forwarding the same container logs from Google Cloud stores each line twice, and the copy
					from Google Cloud has no trace link.{" "}
					<ExternalLink href={OTEL_DOCS}>Google Cloud with OpenTelemetry</ExternalLink>
				</p>
				<div className="flex items-start gap-2 text-foreground">
					<Checkbox
						id={checkboxId}
						className="mt-px"
						checked={understood}
						onCheckedChange={(checked) => setUnderstood(checked === true)}
					/>
					<label htmlFor={checkboxId}>
						I understand that GKE container logs can be stored twice
					</label>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button size="sm" disabled={!understood} onClick={onConfirm}>
						Confirm and show script
					</Button>
					<Button size="sm" variant="outline" onClick={onBack}>
						{backLabel}
					</Button>
				</div>
			</AlertDescription>
		</Alert>
	)
}

/**
 * When a connection's setup panel was opened. `rerun`: it already matched its switches then, so
 * the admin is there to run the script again and the steps stay open until a newer run reports.
 */
interface SetupOpened {
	readonly at: number
	readonly rerun: boolean
	/** The report on record at that moment: a different one is a newer run. */
	readonly seen: string | null
}

/** Admin-only: fetching the script is refused for everyone else, and it carries the secret. */
function GcpSetup({
	connector,
	nowMs,
	opened,
	confirmed,
}: {
	connector: V2GcpConnector
	nowMs: number
	opened: SetupOpened
	/** A run reported since the panel opened: the steps close. */
	confirmed: boolean
}) {
	const sinkExists = connector.applied_logs_enabled === true
	// Null until chosen.
	const [chosenFilter, setChosenFilter] = useState<GcpLogFilter | null>(null)
	const [acknowledged, setAcknowledged] = useState(false)
	const logFilter = gcpLogFilterChoice(chosenFilter, acknowledged, sinkExists)
	const chooseFilter = (next: GcpLogFilter | null) => {
		setChosenFilter(next)
		setAcknowledged(false)
	}
	const { scripts, failure } = useGcpScripts(connector, logFilter.scriptFilter)
	const script = scripts?.setup_script ?? null
	// With log forwarding off the script carries no filter, so there is nothing to acknowledge.
	const acknowledging = connector.logs_enabled && logFilter.unacknowledged

	const reportedAt = connector.setup_reported_at
	const overdue = gcpScriptOverdue(connector, opened.at, nowMs)

	const scopeRoles = gcpScopeRoles(connector.scope_type, connector)
	const scopeName = GCP_SCOPE_NAMES[connector.scope_type].toLowerCase()
	const host = <Mono>{connector.project_id}</Mono>
	const filters = gcpLogFilters(sinkExists)
	const todo = confirmed ? "done" : "current"
	// The filter is a line of text until it is asked for: what it starts on suits most connections.
	const [filterOpen, setFilterOpen] = useState(false)

	// A finished step keeps its title and drops what it asked for.
	return (
		<ol>
			<Step
				number={1}
				state={todo}
				title="Open Cloud Shell"
				detail={
					confirmed ? undefined : connector.scope_type === "project" ? (
						<>Sign in as an Owner of {host}.</>
					) : (
						<>
							Sign in as an Owner of the host project {host}
							{scopeRoles.length > 0
								? ` who also has ${scopeRoles.join(" and ")} on the ${scopeName}`
								: ""}
							.
						</>
					)
				}
			>
				{confirmed ? null : (
					<div>
						<OpenCloudShellButton projectId={connector.project_id} variant="default" />
					</div>
				)}
			</Step>
			<Step
				number={2}
				state={todo}
				title="Paste the script and press Enter"
				detail={
					confirmed
						? undefined
						: !connector.logs_enabled && sinkExists
							? "It takes one to two minutes: after deleting the sink it waits a minute for Google to stop routing to the topic."
							: "It takes about a minute and is safe to run again."
				}
			>
				{confirmed ? null : (
					<>
						{!connector.logs_enabled ? null : filterOpen ? (
							<Field className="items-stretch gap-1.5">
								<FieldLabel>Log filter</FieldLabel>
								<Select
									items={filters}
									value={logFilter.selected}
									onValueChange={chooseFilter}
								>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent alignItemWithTrigger={false}>
										{filters.map((filter) => (
											<SelectItem key={filter.value} value={filter.value}>
												{filter.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{acknowledging ? null : (
									<FieldDescription className={HELP}>
										{logFilter.selected === "keep" ? (
											<>
												Leaves the sink as it is. Maple can&apos;t see that filter:
												read it in the Google Cloud console under{" "}
												<ExternalLink href={logRouterUrl(connector)}>
													Log Router
												</ExternalLink>
												. The recommended filter leaves out GKE container logs.
											</>
										) : (
											<>
												{sinkExists ? "Replaces the sink's current filter. " : null}
												{logFilter.selected === "default" ? (
													<>
														Forwards platform logs: request logs, audit logs and
														managed-service logs. Leaves out{" "}
														<ExternalLink href={GKE_LOGS_DOCS}>
															GKE container logs
														</ExternalLink>{" "}
														and high-volume noise such as health checks.
													</>
												) : (
													"Forwards the recommended logs and GKE container logs. Logs from workloads that also send them over OpenTelemetry are then stored twice."
												)}
											</>
										)}{" "}
										For any other filter, edit <Mono>LOG_FILTER</Mono> in the script
										before you paste it
										{logFilter.selected === "keep" ? (
											<>
												{" "}
												and change <Mono>LOG_FILTER_MODE</Mono> to <Mono>set</Mono>
											</>
										) : null}
										.
									</FieldDescription>
								)}
							</Field>
						) : (
							<p className={PROSE}>
								Log filter ·{" "}
								{filters.find((filter) => filter.value === logFilter.selected)?.label} ·{" "}
								<button type="button" className={LINK} onClick={() => setFilterOpen(true)}>
									Change
								</button>
							</p>
						)}
						{acknowledging ? (
							<GkeContainerLogsAcknowledgement
								backLabel={sinkExists ? "Keep current filter" : "Use recommended filter"}
								onConfirm={() => setAcknowledged(true)}
								onBack={() => chooseFilter(null)}
							/>
						) : (
							<Script
								script={script}
								label="script"
								failure={failure}
								caveat="The script contains this connection's secret. Don't share or commit it. If it leaks, disconnect and connect again."
								note="Its first two and last two lines run it in a bash process of its own, so a failed step can't close your Cloud Shell session. In Cloud Shell they also keep the paste out of shell history."
							/>
						)}
					</>
				)}
			</Step>
			<Step
				number={3}
				state={confirmed ? "done" : overdue && !opened.rerun ? "current" : "pending"}
				title="Maple confirms the connection"
				detail={
					confirmed ? (
						reportedAt === null ? (
							"Confirmed."
						) : (
							<>
								<RelativeTime value={reportedAt} prefix="Confirmed" />.
							</>
						)
					) : opened.rerun && reportedAt !== null ? (
						<>
							<RelativeTime value={reportedAt} prefix="Last confirmed" />. A new run confirms
							again.
						</>
					) : !overdue ? (
						"Maple confirms within a minute of the script ending, usually in seconds. This page updates on its own."
					) : (
						<span className="text-foreground">
							Nothing yet. If the script stopped with an error, fix what it names and paste it
							again: it continues where it stopped. If the ID is wrong, remove this connection
							and connect the right ID: a connection&apos;s ID can&apos;t be changed.{" "}
							<ExternalLink href={`${DOCS}#troubleshooting`}>Troubleshooting</ExternalLink>
						</span>
					)
				}
			/>
		</ol>
	)
}

/** How the plan-limit texts name the billing page. */
const BILLING_PAGE = "Settings, Billing"
// An address ends before the punctuation or the bracket that follows it.
const LINK_PATTERN = new RegExp(`(https://[^\\s)]*[^\\s).,]|${BILLING_PAGE})`)

/**
 * A failure in Maple's own words: prose that wraps. A Google Cloud console address in it becomes
 * a named link, so a long address never breaks a line in the middle of a word, and the billing
 * page it names is a link to it. What Google answered closes the message in brackets: that goes
 * on a line of its own, quieter than what to do.
 */
export function GcpMessage({ text }: { text: string }) {
	const [, message = text, answer] = /^(.*?)\s*(\([^()]*\))?$/s.exec(text) ?? []
	const parts = message.split(LINK_PATTERN)
	return (
		<>
			<p className="[overflow-wrap:anywhere]">
				{parts.map((part, index) =>
					index % 2 === 0 ? (
						part
					) : part === BILLING_PAGE ? (
						<Link key={index} to="/settings" search={{ tab: "billing" }} className={LINK}>
							{part}
						</Link>
					) : (
						<Fragment key={index}>
							<ExternalLink href={part}>
								{part.startsWith("https://console.cloud.google.com/")
									? "Google Cloud console"
									: part}
							</ExternalLink>
							{/* The messages put the address mid-paragraph, with the next sentence right after. */}
							{/^\s+[A-Z(]/.test(parts[index + 1] ?? "") ? "." : null}
						</Fragment>
					),
				)}
			</p>
			{answer === undefined ? null : <p className="mt-1 text-muted-foreground">{answer}</p>}
		</>
	)
}

/** A capability's status: dot, label, when it last delivered, and under it what to know or do. */
function Status({
	status,
	at,
	atPrefix,
	suffix,
	link,
	children,
}: {
	/** A null tone is the hollow dot of a switched-off capability. */
	status: { readonly tone: Tone | null; readonly label: string }
	at?: string | null
	atPrefix?: string
	suffix?: string | null
	/** Where the data shows up, once it does. */
	link?: React.ReactNode
	children?: React.ReactNode
}) {
	return (
		<>
			{/* Each part carries its separator in its left padding, and the row starts that padding
			    outside the clipped box: a part that wraps to a new line loses the separator and starts
			    at the row's edge, under the dot. */}
			<div className="overflow-hidden text-muted-foreground">
				<div className="-ml-5 flex flex-wrap">
					<span className="flex items-center gap-1.5 pl-5 font-medium text-foreground">
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
					{[at ? <RelativeTime key="at" value={at} prefix={atPrefix} /> : null, suffix, link].map(
						(part, index) =>
							part ? (
								<span
									key={index}
									className="relative pl-5 whitespace-nowrap before:absolute before:left-1.5 before:content-['·']"
								>
									{part}
								</span>
							) : null,
					)}
				</div>
			</div>
			{children}
		</>
	)
}

/** The row of a switched-off capability. A dot only while it still exists in Google Cloud. */
function OffStatus({ stillSetUp, children }: { stillSetUp: boolean; children: string }) {
	return (
		<Status status={{ tone: stillSetUp ? "neutral" : null, label: "Off" }}>
			{stillSetUp ? <p>{children}</p> : null}
		</Status>
	)
}

interface StatusProps {
	readonly connector: V2GcpConnector
	readonly nowMs: number
}

function LogStatus({ connector, nowMs }: StatusProps) {
	const state = gcpLogState(connector, nowMs)
	if (state.kind === "off") {
		return (
			<OffStatus stillSetUp={state.stillSetUp}>
				Google Cloud still forwards logs until the setup script runs again. Maple discards them.
			</OffStatus>
		)
	}
	const status = GCP_LOG_STATUS[state.kind]
	switch (state.kind) {
		case "failing":
			return (
				<Status status={status} at={state.lastLogReceivedAt} atPrefix="last accepted log">
					<GcpMessage text={state.error} />
				</Status>
			)
		// What to do about it is said once for the connection: by its steps, its notice or its header.
		case "setup-pending":
			return <Status status={status} />
		case "setup-running":
			return (
				<Status status={status}>
					<p>The script is still working.</p>
				</Status>
			)
		case "waiting":
			return (
				<Status status={status}>
					{state.overdue ? (
						<p>
							No entry has arrived in 20 minutes. Either nothing was logged that passes the
							filter, or the sink can&apos;t publish. Write a test entry: if the sink works,
							this row changes to Receiving logs within a minute. If it doesn&apos;t, run the
							setup script again.
							{/* On a line of its own: it is what to copy, not the end of the sentence. */}
							<span className="mt-1.5 block">
								<Command>
									{`gcloud logging write maple-test "hello from Maple" --project=${connector.project_id}`}
								</Command>
							</span>
						</p>
					) : (
						<p>
							{state.reportedAt === null ? null : (
								<>
									<RelativeTime value={state.reportedAt} prefix="Connection confirmed" />
									.{" "}
								</>
							)}
							A new sink can take about 10 minutes to start forwarding. Entries logged before
							that are not forwarded.
						</p>
					)}
				</Status>
			)
		case "idle":
		case "receiving":
			return (
				<Status
					status={status}
					at={state.lastLogReceivedAt}
					atPrefix="last log"
					link={
						<Link to="/logs" className={LINK}>
							View logs
						</Link>
					}
				/>
			)
	}
}

function MetricsStatus({ connector, nowMs }: StatusProps) {
	const state = gcpMetricsState(connector, nowMs)
	if (state.kind === "off") {
		return (
			<OffStatus stillSetUp={state.stillSetUp}>
				The read-only service account stays in Google Cloud until the setup script runs again. Maple
				no longer uses it.
			</OffStatus>
		)
	}
	const status = GCP_METRICS_STATUS[state.kind]
	const infrastructure = (
		<Link to="/infra/gcp" className={LINK}>
			Open Infrastructure
		</Link>
	)
	switch (state.kind) {
		// What to do about it is said once for the connection: by its steps, its notice or its header.
		case "setup-pending":
			return <Status status={status} />
		case "setup-running":
			return (
				<Status status={status}>
					<p>The script is still working.</p>
				</Status>
			)
		case "waiting":
			return (
				<Status status={status}>
					<p>
						{state.reportedAt === null ? null : (
							<>
								<RelativeTime value={state.reportedAt} prefix="Access confirmed" />.{" "}
							</>
						)}
						{state.overdue
							? "No read has arrived yet. Maple retries every 5 minutes. If this lasts an hour, write to support@maple.dev."
							: "The first read lands within about 10 minutes."}
					</p>
				</Status>
			)
		case "failing":
			return (
				<Status status={status} at={state.lastMetricsReceivedAt} atPrefix="last read">
					<GcpMessage text={state.error} />
				</Status>
			)
		case "incomplete":
			return (
				<Status
					status={status}
					at={state.lastMetricsReceivedAt}
					atPrefix="last read"
					link={infrastructure}
				>
					<GcpMessage text={state.error} />
				</Status>
			)
		case "stalled":
			return (
				<Status
					status={status}
					at={state.lastMetricsReceivedAt}
					atPrefix="last read"
					link={infrastructure}
				>
					<p>Maple retries on its own.</p>
				</Status>
			)
		case "receiving":
			return (
				<Status
					status={status}
					at={state.lastMetricsReceivedAt}
					atPrefix="last read"
					suffix={state.projectCount === null ? null : countLabel(state.projectCount, "project")}
					link={infrastructure}
				>
					{state.resourcesError === null ? null : <GcpMessage text={state.resourcesError} />}
				</Status>
			)
	}
}

/**
 * One thing a connector collects: its name and its switch on one line, under them what it is
 * doing. The status line runs the row's width; a paragraph under it keeps to the measure.
 */
function Capability({
	title,
	checked,
	lock,
	disabled,
	onCheckedChange,
	children,
}: {
	title: string
	checked: boolean
	lock: GcpSwitchLock | null
	disabled: boolean
	/** Absent for non-admins, who read the state from `children`. */
	onCheckedChange: ((checked: boolean) => void) | null
	children: React.ReactNode
}) {
	const lockId = useId()
	const locked = onCheckedChange !== null && lock !== null
	return (
		<section className="flex flex-col gap-0.5 px-4 py-2.5 text-xs/5 text-foreground/80 [&>p]:max-w-[72ch] [&>p]:text-pretty">
			<div className="flex items-center justify-between gap-4">
				<h4 className={cn(TITLE, "text-foreground")}>{title}</h4>
				{onCheckedChange === null ? null : (
					<Switch
						aria-label={title}
						aria-describedby={locked ? lockId : undefined}
						checked={checked}
						disabled={disabled || lock !== null}
						onCheckedChange={onCheckedChange}
					/>
				)}
			</div>
			{children}
			{locked ? (
				<p id={lockId} className="text-muted-foreground">
					{LOCK_NOTES[lock]}
				</p>
			) : null}
		</section>
	)
}

/**
 * Disconnecting a connection whose script has run: clean Google Cloud up first, then remove the
 * connection. The cleanup script reports to Maple, so the dialog sees it finish.
 */
function GcpDisconnectDialog({
	connector,
	disconnecting,
	onDisconnect,
	onClose,
}: {
	connector: V2GcpConnector
	disconnecting: boolean
	onDisconnect: () => void
	onClose: () => void
}) {
	const { scripts, failure } = useGcpScripts(connector, "keep")
	const script = scripts?.cleanup_script ?? null
	useIntervalRefresh(useAtomRefresh(gcpStatusQuery()), { intervalMs: SETTLING_REFRESH_MS, enabled: true })
	const cleaned = connector.applied_logs_enabled === false && connector.applied_metrics_enabled === false

	return (
		<Dialog open onOpenChange={(open) => (open || disconnecting ? undefined : onClose())}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="pr-8">
						Disconnect {GCP_SCOPE_NAMES[connector.scope_type]}{" "}
						<span className="whitespace-nowrap">{connector.scope_id}</span>
					</DialogTitle>
				</DialogHeader>
				<DialogPanel>
					<ol>
						<Step
							number={1}
							state={cleaned ? "done" : "current"}
							title="Remove Maple's resources from Google Cloud"
							detail={
								cleaned && connector.setup_reported_at !== null ? (
									<>
										<RelativeTime
											value={connector.setup_reported_at}
											prefix="Cleaned up"
										/>
										.
									</>
								) : (
									`Run this in Cloud Shell first. It takes ${connector.applied_logs_enabled === true ? "one to two minutes" : "about a minute"} and deletes the log sink, topic, subscription and read-only service account. The APIs it switched on stay on.`
								)
							}
						>
							{cleaned ? null : (
								<>
									<Script
										script={script}
										label="cleanup script"
										failure={failure}
										caveat="The script contains this connection's secret. Don't share or commit it."
									>
										<OpenCloudShellButton projectId={connector.project_id} />
									</Script>
									<p className={cn(PROSE, "text-foreground/80")}>
										Waiting for the cleanup script. This updates on its own.
									</p>
								</>
							)}
						</Step>
						<Step
							number={2}
							state={cleaned ? "current" : "pending"}
							title="Disconnect from Maple"
							detail="Maple stops accepting this connection's logs and reading its metrics. Data already in Maple is kept."
						/>
					</ol>
					{/* What the button under it costs, in the dialog's own voice and not a step's small print. */}
					{cleaned ? null : (
						<p className={cn(MEASURE, "mt-5 text-xs/5 text-pretty text-foreground/80")}>
							If you skip the cleanup, Google Cloud keeps publishing logs to Pub/Sub, billed by
							Google, until the script runs.
						</p>
					)}
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" disabled={disconnecting} />}>
						Cancel
					</DialogClose>
					<Button
						variant={cleaned ? "destructive" : "destructive-outline"}
						loading={disconnecting}
						onClick={onDisconnect}
					>
						{cleaned ? "Disconnect" : "Disconnect anyway"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function GcpConnectorRow({
	connector: saved,
	metricsAvailable,
	isAdmin,
	nowMs,
	onRemoved,
}: {
	connector: V2GcpConnector
	metricsAvailable: boolean
	isAdmin: boolean
	nowMs: number
	onRemoved: (removed: RemovedGcpConnector) => void
}) {
	// One atom for every row, running one call at a time: a second save would cancel the first.
	// So `updating` disables the switches of every connector while any save is in flight.
	const updateAtom = MapleApiV2AtomClient.mutation("gcpIntegration", "updateConnector")
	const update = useAtomSet(updateAtom, { mode: "promiseExit" })
	const updating = useAtomValue(updateAtom).waiting
	const remove = useAtomSet(MapleApiV2AtomClient.mutation("gcpIntegration", "deleteConnector"), {
		mode: "promiseExit",
	})
	// What a switch was just set to, shown until the status read delivers a newer connector. Without
	// it a saved switch snaps back for the length of the refetch.
	const [asked, setAsked] = useState<{ readonly of: V2GcpConnector; readonly flags: GcpFlags } | null>(null)
	const connector = asked !== null && asked.of === saved ? { ...saved, ...asked.flags } : saved
	const label = gcpScopeLabel(connector)
	const pendingChanges = gcpPendingChanges(connector, nowMs)
	const scriptNeeded = gcpScriptNeeded(connector, nowMs)
	// No run has reported: as far as Maple knows, nothing exists in Google Cloud.
	const neverReported =
		connector.applied_logs_enabled === null && connector.applied_metrics_enabled === null
	const cleanedUp = connector.applied_logs_enabled === false && connector.applied_metrics_enabled === false
	// What the notice or the header says while Google Cloud waits on the script: who runs it.
	const who = isAdmin ? "Run the setup script" : "A Maple organization admin needs to run the setup script"
	const reportedAt = saved.setup_reported_at
	const open = (rerun: boolean): SetupOpened => ({ at: Date.now(), rerun, seen: reportedAt })
	// A connection that waits on the script opens on its steps. Found waiting on a change, it opens
	// as a run to repeat: nobody has said a run is under way, so the last step does not time one.
	const [opened, setOpened] = useState<SetupOpened | null>(() =>
		scriptNeeded === null ? null : open(scriptNeeded === "changes-pending"),
	)
	// A run's sections report one after the other: confirmed once the last one has.
	const confirmed =
		opened !== null &&
		scriptNeeded === null &&
		!gcpSetupRunning(connector, nowMs) &&
		(!opened.rerun || reportedAt !== opened.seen)
	// Confirmed, the panel shows three check marks and no script: the button then brings it back.
	const scriptShown = opened !== null && !confirmed
	const showScript = () => setOpened(open(scriptNeeded === null))

	const [disconnectOpen, setDisconnectOpen] = useState(false)

	// Only the flipped switch is sent: the API leaves an omitted one as it is, so a stale view of
	// the other cannot overwrite it.
	async function save(patch: Partial<GcpFlags>) {
		setAsked({ of: saved, flags: { ...connector, ...patch } })
		const result = await update({
			params: { id: saved.id },
			payload: patch,
			reactivityKeys: [...REACTIVITY_KEYS, ...SCRIPT_REACTIVITY_KEYS],
		})
		if (Exit.isSuccess(result)) {
			setOpened(open(false))
			return
		}

		setAsked(null)
		showErrorToast(result, { title: "Failed to save the change" })
	}

	// Resolving to `false` keeps the dialog open for a retry.
	const [disconnect, disconnecting] = useAsyncAction(async () => {
		const result = await remove({ params: { id: saved.id }, reactivityKeys: REACTIVITY_KEYS })
		if (Exit.isFailure(result)) {
			showErrorToast(result, { title: "Failed to disconnect" })
			return false
		}
		// Kept unless the cleanup script was seen to run. A script that stopped part of the way, or
		// could not reach Maple, leaves resources behind without a report.
		if (!cleanedUp) {
			onRemoved({
				id: saved.id,
				label,
				hostProjectId: saved.project_id,
				cleanupScript: result.value.cleanup_script,
				reported: !neverReported,
			})
		}
		return true
	})

	const logsLock = gcpSwitchLock(connector, "logs", metricsAvailable)
	const metricsLock = gcpSwitchLock(connector, "metrics", metricsAvailable)

	const state = gcpConnectionState(connector, nowMs)
	const setup =
		isAdmin && opened !== null ? (
			<GcpSetup connector={connector} nowMs={nowMs} opened={opened} confirmed={confirmed} />
		) : null
	// A first setup leads with its steps. A later run has them under the switches that ask for it.
	const stepsFirst = opened?.seen === null

	return (
		<Panel className="@container">
			{/* The card's width decides where the buttons go, so every card of a page agrees: beside the
			    name when wide, under it when narrow. Wide, the header is as tall with buttons as without. */}
			<div className="flex flex-col gap-2 px-4 py-3 @xl:min-h-13 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<h3 className={TITLE}>{label}</h3>
						{state === "healthy" ? null : (
							<Badge variant={state === "attention" ? "warn" : "outline"}>
								{GCP_CONNECTION_LABEL[state]}
							</Badge>
						)}
					</div>
					{connector.scope_type !== "project" ? (
						<p className="text-xs/5 text-muted-foreground">
							host project <span className="font-mono">{connector.project_id}</span>
						</p>
					) : null}
					{/* With no steps open and no notice, nothing else says who has to do what. */}
					{scriptNeeded === "setup-pending" && setup === null ? (
						<p className="text-xs/5 text-foreground/80">
							{who}
							{reportedAt === null ? "" : " again"}.
						</p>
					) : null}
				</div>
				{isAdmin ? (
					<div className="flex shrink-0 items-center gap-1.5">
						<Button
							size="sm"
							variant="outline"
							aria-expanded={scriptShown}
							onClick={() => (scriptShown ? setOpened(null) : showScript())}
						>
							{scriptShown ? "Hide setup script" : "Show setup script"}
						</Button>
						<Button size="sm" variant="outline" onClick={() => setDisconnectOpen(true)}>
							{neverReported ? "Remove" : "Disconnect"}
						</Button>
					</div>
				) : null}
			</div>
			{stepsFirst && setup !== null ? (
				<div className="border-t border-border/60 px-4 py-5">{setup}</div>
			) : null}
			<div className="divide-y divide-border/60 border-t border-border/60">
				<Capability
					title="Log forwarding"
					checked={connector.logs_enabled}
					lock={logsLock}
					disabled={updating}
					onCheckedChange={isAdmin ? (logs_enabled) => void save({ logs_enabled }) : null}
				>
					<LogStatus connector={connector} nowMs={nowMs} />
				</Capability>
				<Capability
					title="Metrics and resources"
					checked={connector.metrics_enabled}
					lock={metricsLock}
					disabled={updating}
					onCheckedChange={isAdmin ? (metrics_enabled) => void save({ metrics_enabled }) : null}
				>
					<MetricsStatus connector={connector} nowMs={nowMs} />
				</Capability>
			</div>
			{/* The notice and the steps that act on it share one band. */}
			{pendingChanges.length === 0 && (stepsFirst || setup === null) ? null : (
				<div className="flex flex-col gap-5 border-t border-border/60 px-4 py-5">
					{pendingChanges.length === 0 ? null : (
						<Alert variant="warn" size="sm" role="status">
							<AlertWarningIcon size={14} />
							<AlertTitle>Google Cloud doesn&apos;t match these switches yet</AlertTitle>
							<AlertDescription className={cn(HELP, "gap-1")}>
								<p>
									{who} again. It will
									{pendingChanges.length === 1 ? ` ${pendingChanges[0]}.` : ":"}
								</p>
								{pendingChanges.length === 1 ? null : (
									<ul className="list-disc pl-4">
										{pendingChanges.map((line) => (
											<li key={line}>{line}</li>
										))}
									</ul>
								)}
								{isAdmin && cleanedUp ? (
									<p>To remove the connection instead, click Disconnect.</p>
								) : null}
							</AlertDescription>
						</Alert>
					)}
					{stepsFirst ? null : setup}
				</div>
			)}

			{neverReported ? (
				<ConfirmDialog
					open={disconnectOpen}
					onOpenChange={setDisconnectOpen}
					title={`Remove ${label}?`}
					description="Maple hasn't seen the setup script run, so there should be nothing in Google Cloud. If it ran part of the way, use the cleanup script offered after you remove the connection."
					confirmLabel="Remove"
					onConfirm={disconnect}
				/>
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

	const [adding, setAdding] = useState(false)
	const [removed, setRemoved] = useAtom(removedGcpConnectorsAtomFamily(getActiveOrgId() ?? "default"))
	// The states turn on the clock: a grant's grace ends, a silent sink becomes overdue.
	const nowMs = useLiveClock()

	// Keep the last loaded status if a poll fails.
	const status = Option.getOrNull(AsyncResult.value(statusResult))
	const connectors = status?.connectors ?? []
	const metricsAvailable = status?.metrics_available === true

	const settling = connectors.some((connector) => gcpConnectionState(connector, nowMs) !== "healthy")
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

	const cleanup = removed.map((entry) => (
		<Panel key={entry.id} padded tone="muted" className="gap-3">
			<div className="flex flex-col gap-1">
				<h3 className={TITLE}>
					{entry.label} {entry.reported ? "disconnected" : "removed"}
				</h3>
				<p className={PROSE}>
					{entry.reported
						? "If you haven't yet, run the cleanup script in Cloud Shell."
						: "If its setup script ran part of the way, run the cleanup script in Cloud Shell."}{" "}
					This stays here until you click Done.
				</p>
			</div>
			<div className="flex flex-wrap gap-2">
				<CopyScriptButton script={entry.cleanupScript} label="cleanup script" />
				<OpenCloudShellButton projectId={entry.hostProjectId} />
				<Button
					size="sm"
					variant="outline"
					onClick={() => setRemoved(removed.filter((other) => other.id !== entry.id))}
				>
					Done
				</Button>
			</div>
		</Panel>
	))
	const newConnection = (onCancel?: () => void) => (
		<SettingsSection
			title="New connection"
			description={
				<span className={cn(MEASURE, "block text-pretty")}>
					Choose what to connect and Maple writes its setup script. You run it in Cloud Shell; it
					takes about a minute.
				</span>
			}
		>
			<GcpConnectForm
				metricsAvailable={metricsAvailable}
				existing={connectors}
				onCreated={() => setAdding(false)}
				onCancel={onCancel}
			/>
		</SettingsSection>
	)

	if (connectors.length === 0) {
		return (
			<div className="flex w-full max-w-3xl flex-col gap-10">
				{cleanup}
				<IntegrationEmpty
					icon={GoogleCloudIcon}
					backerIcon={GoogleCloudMonoIcon}
					accent={GCP_ACCENT}
					// A section follows the tiles at a section's distance, the empty card at the others'.
					className={isAdmin ? "gap-10" : undefined}
				>
					<IntegrationEmptyFeatures>
						<IntegrationEmptyFeature
							label="Logs"
							title="Google Cloud's logs"
							description="Request logs, audit logs and managed services such as Cloud SQL. GKE container logs are left out by default."
						/>
						<IntegrationEmptyFeature
							label="Metrics"
							title="Workloads, no agents"
							description="Cloud Run, GKE, Compute Engine, Cloud SQL, Pub/Sub and more, read from Cloud Monitoring every 5 minutes."
						/>
						<IntegrationEmptyFeature
							label="Access"
							title="One script, read-only"
							description="You run it in Cloud Shell. No OAuth, no service account keys, no write access for Maple."
						/>
					</IntegrationEmptyFeatures>
					{isAdmin ? (
						newConnection()
					) : (
						<IntegrationEmptyCard>
							<IntegrationEmptyMedia />
							<IntegrationEmptyHint>
								A Maple organization admin connects Google Cloud by running a setup script in
								Cloud Shell.
							</IntegrationEmptyHint>
						</IntegrationEmptyCard>
					)}
				</IntegrationEmpty>
			</div>
		)
	}

	return (
		<div className="flex w-full max-w-3xl flex-col gap-10">
			{cleanup}
			{adding ? newConnection(() => setAdding(false)) : null}
			<SettingsSection
				title="Connections"
				actions={
					isAdmin && !adding ? (
						<Button size="sm" variant="outline" onClick={() => setAdding(true)}>
							Add connection
						</Button>
					) : undefined
				}
				framed={false}
				className="gap-4"
			>
				{connectors.map((connector) => (
					<GcpConnectorRow
						key={connector.id}
						connector={connector}
						metricsAvailable={metricsAvailable}
						isAdmin={isAdmin}
						nowMs={nowMs}
						onRemoved={(entry) => setRemoved([...removed, entry])}
					/>
				))}
			</SettingsSection>
			{showNotAdmin ? (
				<p className="text-xs text-muted-foreground">
					Only Maple organization admins can add, change or disconnect connections.
				</p>
			) : null}
		</div>
	)
}
