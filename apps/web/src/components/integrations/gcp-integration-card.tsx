import { Fragment, useId, useState } from "react"
import type React from "react"
import { Link } from "@tanstack/react-router"
import { Exit, Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import type { GcpLogFilter, GcpScopeType } from "@maple/domain/primitives"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
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
import { Item, ItemActions, ItemContent, ItemMedia } from "@maple/ui/components/ui/item"
import { Panel } from "@maple/ui/components/ui/panel"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Switch } from "@maple/ui/components/ui/switch"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import {
	removedGcpConnectorsAtomFamily,
	type RemovedGcpConnector,
} from "@/atoms/gcp-removed-connectors-atoms"
import { ErrorState } from "@/components/common/error-state"
import { OptionCard } from "@/components/common/option-card"
import { RelativeTime } from "@/components/common/relative-time"
import { REPLAY_BLOCK_CLASS } from "@/components/common/replay-privacy"
import { CircleInfoIcon, ExternalLinkIcon, GoogleCloudIcon, GoogleCloudMonoIcon } from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { useLiveClock } from "@/hooks/use-live-clock"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { Result, useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { errorMessage, showErrorToast } from "@/lib/error-toast"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { getActiveOrgId } from "@/lib/services/common/auth-headers"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	GCP_CONNECTION_STATUS,
	GCP_LOG_STATUS,
	GCP_METRICS_STATUS,
	GCP_SCOPE_NAMES,
	cloudShellUrl,
	gcpConnectionState,
	gcpCreateRequest,
	gcpLogState,
	gcpMetricsState,
	gcpOverlapNote,
	gcpPendingChanges,
	gcpScopeLabel,
	gcpScopeRoles,
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
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"
import { PlanetScaleSetupChecklist, type ChecklistStep } from "./planetscale-setup-checklist"

const REACTIVITY_KEYS = ["gcpIntegration"]
/** Invalidated by a switch change: the script depends on what the connector has switched on. */
const SCRIPT_REACTIVITY_KEYS = ["gcpSetupScripts"]

/** Fast enough to see a script run confirmed, the first data land, or an error clear. */
const SETTLING_REFRESH_MS = 10_000
/** Keeps the "last log" and "last read" times and a new error current on a page left open. */
const STEADY_REFRESH_MS = 60_000
/** A script run takes about a minute. Past this the panel says what to check. */
const SCRIPT_OVERDUE_MS = 5 * 60_000
/** How much of a script shows before "Show all lines": the wrapper and the header comment. */
const SCRIPT_PREVIEW_LINES = 10

const DOCS = "https://maple.dev/docs/integrations/gcp"
const MANAGE_RESOURCES_URL = "https://console.cloud.google.com/cloud-resource-manager"

const PROJECT_ID_RULE =
	"A project ID is 6 to 30 lowercase letters, digits and hyphens. It starts with a letter and can't end with a hyphen. The project name and number don't work."

/** The add form's scope choices, in display order. */
const SCOPES = {
	organization: {
		description: "Every project in the organization, including new ones.",
		idLabel: "Organization ID",
		idRule: "An organization ID is digits only, such as 123456789012.",
		listCommand: "gcloud organizations list",
	},
	folder: {
		description: "Every project in the folder, including new ones.",
		idLabel: "Folder ID",
		idRule: "A folder ID is digits only, such as 123456789012.",
		listCommand: "gcloud resource-manager folders list --organization=ORGANIZATION_ID",
	},
	project: {
		description: "One project.",
		idLabel: "Project ID",
		idRule: PROJECT_ID_RULE,
		listCommand: "gcloud projects list",
	},
} as const
const SCOPE_TYPES: ReadonlyArray<GcpScopeType> = ["organization", "folder", "project"]

const LOCK_NOTES = {
	"last-on": "A connection keeps one switch on. To stop collecting, disconnect.",
	"metrics-unavailable": "Not available on this Maple deployment.",
} as const satisfies { readonly [Lock in GcpSwitchLock]: string }

const LOG_FILTERS = [
	{ value: "keep", label: "Keep the sink's current filter" },
	{ value: "default", label: "Maple default" },
	{ value: "exclude_gke_container_logs", label: "Maple default, without GKE container logs" },
] as const satisfies ReadonlyArray<{ value: GcpLogFilter; label: string }>

/** The card's one link style, the other integrations' (Railway's token link). */
const LINK = "underline underline-offset-2 hover:no-underline"

/** A link out of Maple. `icon` off inside a sentence, where punctuation follows it. */
function ExternalLink({
	href,
	icon = true,
	children,
}: {
	href: string
	icon?: boolean
	children: React.ReactNode
}) {
	return (
		<a href={href} target="_blank" rel="noreferrer" className={LINK}>
			{children}
			{icon ? <ExternalLinkIcon size={12} className="ml-1 inline align-[-1px]" /> : null}
		</a>
	)
}

/** An identifier inside a sentence: mono without a chip, so punctuation sits tight against it. */
function Mono({ children }: { children: React.ReactNode }) {
	return <span className="font-mono text-foreground">{children}</span>
}

/** A shell command inside a sentence, with its own copy button. */
function Command({ children }: { children: string }) {
	return (
		<span className="inline-flex max-w-full items-center gap-0.5 align-middle">
			<InlineCode className="min-w-0 [overflow-wrap:anywhere]">{children}</InlineCode>
			<CopyButton value={children} label="command" toast={false} iconSize={12} className="size-5" />
		</span>
	)
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
 * A script as it will be pasted: the head of it, and all of it on request. Both scripts are a few
 * hundred lines, so the full text scrolls inside its box.
 */
function ScriptBlock({ script, label, secret = false }: { script: string; label: string; secret?: boolean }) {
	const [expanded, setExpanded] = useState(false)
	const text = script.trimEnd()
	const lines = text.split("\n")
	return (
		<div className="overflow-hidden rounded-md border border-border bg-background/50">
			{/* The dashboard records itself with rrweb, which serializes plain text verbatim. */}
			<pre
				tabIndex={0}
				role="region"
				aria-label={label}
				className={cn(
					"overflow-auto p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
					expanded && "max-h-[28rem]",
					secret && REPLAY_BLOCK_CLASS,
				)}
			>
				{expanded ? text : lines.slice(0, SCRIPT_PREVIEW_LINES).join("\n")}
			</pre>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				className="w-full border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:bg-muted/40 hover:text-foreground"
			>
				{expanded ? "Show fewer lines" : `Show all ${lines.length} lines`}
			</button>
		</div>
	)
}

/** A loaded script, a loading placeholder, or the failure with a retry. */
function ScriptPreview({
	script,
	label,
	failure,
}: {
	script: string | null
	label: string
	failure: { readonly message: string; readonly retry: () => void; readonly retrying: boolean } | null
}) {
	if (script !== null) return <ScriptBlock script={script} label={label} secret />
	if (failure === null) return <Skeleton className="h-72 w-full" />
	return (
		<div className="flex flex-wrap items-center gap-2">
			<p className="text-xs text-severity-error" role="alert">
				{failure.message}
			</p>
			<Button size="sm" variant="outline" onClick={failure.retry} loading={failure.retrying}>
				Try again
			</Button>
		</div>
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
		void submit()
	}

	return (
		<form onSubmit={handleSubmit} className="flex w-full flex-col gap-4 text-left">
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-2 text-sm font-medium">What to connect</legend>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
					<FieldError match>{scope.idRule}</FieldError>
				) : (
					<FieldDescription>
						{aggregated ? (
							<>
								Digits only. Find it in the console under IAM & Admin,{" "}
								<ExternalLink href={MANAGE_RESOURCES_URL} icon={false}>
									Manage resources
								</ExternalLink>
								, or run{" "}
							</>
						) : (
							<>
								The ID, not the name or number. Find it in the console&apos;s project picker,
								or run{" "}
							</>
						)}
						<Command>{scope.listCommand}</Command>
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
						<FieldError match>{PROJECT_ID_RULE}</FieldError>
					) : (
						<FieldDescription>
							The project that holds Maple&apos;s Pub/Sub topic and read-only service account.
							Use a shared operations project inside the organization, with billing enabled,
							that won&apos;t be deleted. Google bills the Pub/Sub and Cloud Monitoring usage to
							it.
						</FieldDescription>
					)}
				</Field>
			) : null}
			<fieldset className="flex flex-col gap-2.5">
				<legend className="mb-2 text-sm font-medium">What to collect</legend>
				<Field className="grid grid-cols-[auto_1fr] items-start gap-x-2 gap-y-0.5">
					<Checkbox
						id="gcp-logs-enabled"
						className="mt-px"
						checked={draft.logsEnabled}
						onCheckedChange={(checked) => edit({ logsEnabled: checked === true })}
					/>
					<FieldLabel htmlFor="gcp-logs-enabled">Log forwarding</FieldLabel>
					<FieldDescription className="col-start-2">
						A log sink sends Cloud Logging entries to Maple through Pub/Sub.
					</FieldDescription>
				</Field>
				<Field
					className="grid grid-cols-[auto_1fr] items-start gap-x-2 gap-y-0.5"
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
					<FieldDescription className="col-start-2">
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
				<p className="text-xs text-muted-foreground">
					Google bills Pub/Sub and Cloud Monitoring API usage to your account.{" "}
					<ExternalLink href={`${DOCS}#google-cloud-costs`}>Costs</ExternalLink>
				</p>
			</fieldset>
			<p className="text-xs text-muted-foreground">
				To run the script you need Owner on{" "}
				{isGcpProjectId(ownerOn) ? (
					<Mono>{ownerOn}</Mono>
				) : aggregated ? (
					"the host project"
				) : (
					"the project"
				)}
				{scopeRoles.length > 0 ? `, plus ${scopeRoles.join(" and ")} on the ${scopeName}` : ""}.
			</p>
			{overlap === null ? null : (
				<Alert size="sm" role="note">
					<CircleInfoIcon size={14} />
					<AlertDescription>{overlap}</AlertDescription>
				</Alert>
			)}
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
					Get setup script
				</Button>
			</div>
		</form>
	)
}

type SetupStepId = "shell" | "script" | "confirm"

/** Admin-only: fetching the script is refused for everyone else, and it carries the secret. */
function GcpSetup({ connector, nowMs }: { connector: V2GcpConnector; nowMs: number }) {
	const sinkExists = connector.applied_logs_enabled === true
	// Null until chosen. An existing sink keeps its filter unless the admin asks for another, so
	// copying the script again for a switch change never resets it.
	const [chosenFilter, setChosenFilter] = useState<GcpLogFilter | null>(null)
	const logFilter = chosenFilter ?? (sinkExists ? "keep" : "default")
	const { scripts, failure } = useGcpScripts(connector, logFilter)
	const script = scripts?.setup_script ?? null

	const state = gcpConnectionState(connector, nowMs)
	const matches = state !== "setup-pending" && state !== "changes-pending"
	const reportedAt = connector.setup_reported_at
	const [openedAt] = useState(() => Date.now())
	// Opened on a connection that already matches its switches: the admin is here to run the script
	// again, so the steps stay open until a newer run reports.
	const [rerun] = useState(matches)
	const confirmed = matches && (!rerun || (reportedAt !== null && Date.parse(reportedAt) > openedAt))
	const scopeRoles = gcpScopeRoles(connector.scope_type, connector)
	const scopeName = GCP_SCOPE_NAMES[connector.scope_type].toLowerCase()
	const host = <Mono>{connector.project_id}</Mono>
	const filters = LOG_FILTERS.filter((filter) => filter.value !== "keep" || sinkExists)
	const todo = confirmed ? "done" : "current"

	const steps: ReadonlyArray<ChecklistStep<SetupStepId>> = [
		{
			id: "shell",
			title: "Open Cloud Shell",
			state: todo,
			waitingOnMaple: false,
			detail:
				connector.scope_type === "project" ? (
					<>Sign in as an Owner of {host}.</>
				) : (
					<>
						Sign in as an Owner of the host project {host}
						{scopeRoles.length > 0
							? ` who also has ${scopeRoles.join(" and ")} on the ${scopeName}`
							: ""}
						.
					</>
				),
		},
		{
			id: "script",
			title: "Paste the script and press Enter",
			state: todo,
			waitingOnMaple: false,
			detail: "It takes about a minute and is safe to run again.",
		},
		{
			id: "confirm",
			title: "Maple confirms the connection",
			state: confirmed ? "done" : "pending",
			waitingOnMaple: false,
			detail: confirmed ? (
				reportedAt === null ? (
					"Confirmed."
				) : (
					<>
						<RelativeTime value={reportedAt} prefix="Confirmed" />.
					</>
				)
			) : matches && reportedAt !== null ? (
				<>
					<RelativeTime value={reportedAt} prefix="Last confirmed" />. A new run confirms again.
				</>
			) : nowMs - openedAt < SCRIPT_OVERDUE_MS ? (
				"About 15 seconds after the script ends. This page updates on its own."
			) : (
				<>
					Nothing yet. If the script stopped with an error, fix what it names and paste it again: it
					continues where it stopped.{" "}
					<ExternalLink href={`${DOCS}#troubleshooting`}>Troubleshooting</ExternalLink>
				</>
			),
		},
	]

	return (
		<div className="border-t border-border/60 bg-muted/20 p-4">
			<PlanetScaleSetupChecklist
				stacked
				steps={steps}
				actions={{
					shell: <OpenCloudShellButton projectId={connector.project_id} />,
					script: (
						<div className="flex flex-col gap-3">
							{connector.logs_enabled ? (
								<Field className="items-stretch gap-1.5">
									<FieldLabel className="text-xs sm:text-xs">Log filter</FieldLabel>
									<Select
										items={filters}
										value={logFilter}
										onValueChange={(next) => setChosenFilter(next)}
									>
										<SelectTrigger size="sm" className="w-full text-xs sm:w-80">
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
									<FieldDescription>
										{sinkExists ? "Keep leaves the filter on your sink as it is. " : ""}
										Maple default leaves out Data Access audit logs, load balancer health
										checks, Kubernetes lease renewals and VM serial console output. Leave
										out GKE container logs too if your pods already send them through an
										OpenTelemetry collector. For any other filter, edit{" "}
										<Mono>LOG_FILTER</Mono> in the script and change{" "}
										<Mono>LOG_FILTER_MODE</Mono> to <Mono>set</Mono>.
									</FieldDescription>
								</Field>
							) : null}
							<div>
								<CopyScriptButton script={script} label="script" />
							</div>
							<ScriptPreview script={script} label="Setup script" failure={failure} />
							<div className="flex flex-col gap-1 text-xs text-muted-foreground">
								<p>
									The script contains this connection&apos;s secret. Don&apos;t share or
									commit it. If it leaks, disconnect and connect again.
								</p>
								<p>
									Its first two and last two lines run it in a bash process of its own, so a
									failed step can&apos;t close your Cloud Shell session. They also keep the
									paste out of shell history.
								</p>
							</div>
						</div>
					),
				}}
			/>
		</div>
	)
}

const URL_PATTERN = /(https:\/\/\S+)/

/**
 * A failure in Maple's own words: prose that wraps. Its one URL, a Google Cloud console page,
 * becomes a named link, so a long address never breaks a line in the middle of a word.
 */
export function GcpMessage({ text }: { text: string }) {
	const parts = text.split(URL_PATTERN)
	return (
		<p className="[overflow-wrap:anywhere]">
			{parts.map((part, index) =>
				index % 2 === 0 ? (
					part
				) : (
					<Fragment key={part}>
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
	status: { readonly tone: "ok" | "warn" | "crit" | "neutral" | null; readonly label: string }
	at?: string | null
	atPrefix?: string
	suffix?: string | null
	/** Where the data shows up, once it does. */
	link?: React.ReactNode
	children?: React.ReactNode
}) {
	return (
		<>
			<div className="flex flex-wrap items-center gap-x-1.5">
				{status.tone === null ? null : <StatusDot tone={status.tone} />}
				<span className="font-medium text-foreground">{status.label}</span>
				{at ? (
					<span>
						{"· "}
						<RelativeTime value={at} prefix={atPrefix} />
					</span>
				) : null}
				{suffix ? <span>· {suffix}</span> : null}
				{link ? <span>· {link}</span> : null}
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
	/** What a row waiting on the setup script says: who runs it, and whether it ran before. */
	readonly runScript: string
}

function LogStatus({ connector, nowMs, runScript }: StatusProps) {
	const state = gcpLogState(connector, nowMs)
	const status = GCP_LOG_STATUS[state.kind]
	switch (state.kind) {
		case "off":
			return (
				<OffStatus stillSetUp={state.stillSetUp}>
					Google Cloud still forwards logs until the setup script runs again. Maple discards them.
				</OffStatus>
			)
		case "failing":
			return (
				<Status status={status} at={state.lastLogReceivedAt} atPrefix="last accepted log">
					<GcpMessage text={state.error} />
				</Status>
			)
		case "setup-pending":
			return (
				<Status status={status}>
					<p>{runScript}</p>
				</Status>
			)
		case "waiting":
			return (
				<Status status={status}>
					{state.overdue ? (
						<p>
							No entry has arrived in 20 minutes. Either nothing was logged that passes the
							filter, or the sink can&apos;t publish. Write a test entry: if the sink works,
							this row changes to Receiving logs within a minute.{" "}
							<Command>
								{`gcloud logging write maple-test "hello from Maple" --project=${connector.project_id}`}
							</Command>
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

function MetricsStatus({ connector, nowMs, runScript }: StatusProps) {
	const state = gcpMetricsState(connector, nowMs)
	const status = GCP_METRICS_STATUS[state.kind]
	switch (state.kind) {
		case "off":
			return (
				<OffStatus stillSetUp={state.stillSetUp}>
					The read-only service account stays in Google Cloud until the setup script runs again.
					Maple no longer uses it.
				</OffStatus>
			)
		case "setup-pending":
			return (
				<Status status={status}>
					<p>{runScript}</p>
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
						The first read lands within about 10 minutes.
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
				<Status status={status} at={state.lastMetricsReceivedAt} atPrefix="last read">
					<GcpMessage text={state.error} />
				</Status>
			)
		case "stalled":
			return (
				<Status status={status} at={state.lastMetricsReceivedAt} atPrefix="last read">
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
				>
					{state.resourcesError === null ? null : <GcpMessage text={state.resourcesError} />}
				</Status>
			)
	}
}

/**
 * One thing a connector collects: its name, what it is doing, its switch. On a narrow screen the
 * status drops under the name and the switch.
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
		<section className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2 text-xs/5">
			<h4 className="order-1 flex-1 font-medium sm:w-40 sm:flex-none">{title}</h4>
			<div className="order-3 flex min-w-0 basis-full flex-col text-muted-foreground sm:order-2 sm:flex-1 sm:basis-0">
				{children}
				{locked ? <p id={lockId}>{LOCK_NOTES[lock]}</p> : null}
			</div>
			{onCheckedChange === null ? null : (
				<Switch
					aria-label={title}
					aria-describedby={locked ? lockId : undefined}
					className="order-2 mt-0.5 sm:order-3"
					checked={checked}
					disabled={disabled || lock !== null}
					onCheckedChange={onCheckedChange}
				/>
			)}
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

	const steps: ReadonlyArray<ChecklistStep<"cleanup" | "disconnect">> = [
		{
			id: "cleanup",
			title: "Remove Maple's resources from Google Cloud",
			state: cleaned ? "done" : "current",
			waitingOnMaple: false,
			detail:
				cleaned && connector.setup_reported_at !== null ? (
					<>
						<RelativeTime value={connector.setup_reported_at} prefix="Cleaned up" />.
					</>
				) : (
					"Run this in Cloud Shell first. It deletes the log sink, topic, subscription and read-only service account. The APIs it switched on stay on."
				),
		},
		{
			id: "disconnect",
			title: "Disconnect from Maple",
			state: cleaned ? "current" : "pending",
			waitingOnMaple: false,
			detail: "Maple stops accepting this connection's logs and reading its metrics. Data already in Maple is kept.",
		},
	]

	return (
		<Dialog open onOpenChange={(open) => (open || disconnecting ? undefined : onClose())}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="pr-8">Disconnect {gcpScopeLabel(connector)}</DialogTitle>
				</DialogHeader>
				<DialogPanel className="flex flex-col gap-3">
					<PlanetScaleSetupChecklist
						steps={steps}
						actions={{
							cleanup: (
								<div className="flex flex-col gap-3">
									<div className="flex flex-wrap gap-2">
										<CopyScriptButton script={script} label="cleanup script" />
										<OpenCloudShellButton projectId={connector.project_id} />
									</div>
									<ScriptPreview script={script} label="Cleanup script" failure={failure} />
									<p className="text-xs text-muted-foreground">
										Waiting for the cleanup script. This updates on its own.
									</p>
								</div>
							),
						}}
					/>
					{cleaned ? null : (
						<p className="text-xs text-muted-foreground">
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
	const state = gcpConnectionState(connector, nowMs)
	const pendingChanges = gcpPendingChanges(connector, nowMs)
	const neverReported =
		connector.applied_logs_enabled === null && connector.applied_metrics_enabled === null
	// What a row or the notice says while Google Cloud waits on the script.
	const who = isAdmin ? "Run the setup script" : "A Maple organization admin needs to run the setup script"
	const runScript = `${who}${neverReported ? "" : " again"}.`
	// A connection whose script has not run opens on its next step.
	const [setupOpen, setSetupOpen] = useState(state === "setup-pending")
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
			setSetupOpen(true)
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
		// Nothing to clean up before the first run, and nothing left after a confirmed cleanup.
		if (connector.applied_logs_enabled === true || connector.applied_metrics_enabled === true) {
			onRemoved({
				id: saved.id,
				label,
				hostProjectId: saved.project_id,
				cleanupScript: result.value.cleanup_script,
			})
		}
		return true
	})

	const logsLock = gcpSwitchLock(connector, "logs", metricsAvailable)
	const metricsLock = gcpSwitchLock(connector, "metrics", metricsAvailable)

	return (
		<div className="border-t border-border/60 pb-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 pb-1">
				{/* The basis makes the buttons wrap under the name on a phone instead of squeezing it. */}
				<div className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
					<span className="font-medium">{label}</span>
					{connector.scope_type !== "project" ? (
						<span className="text-xs text-muted-foreground">
							host project <span className="font-mono">{connector.project_id}</span>
						</span>
					) : null}
					{state === "setup-pending" || state === "changes-pending" ? (
						<Badge variant="outline">{GCP_CONNECTION_STATUS[state].label}</Badge>
					) : null}
				</div>
				{isAdmin ? (
					<div className="flex shrink-0 items-center gap-1.5">
						<Button
							size="sm"
							variant="outline"
							aria-expanded={setupOpen}
							onClick={() => setSetupOpen(!setupOpen)}
						>
							{setupOpen ? "Hide setup script" : "Show setup script"}
						</Button>
						<Button size="sm" variant="outline" onClick={() => setDisconnectOpen(true)}>
							Disconnect
						</Button>
					</div>
				) : null}
			</div>
			<Capability
				title="Log forwarding"
				checked={connector.logs_enabled}
				lock={logsLock}
				disabled={updating}
				onCheckedChange={isAdmin ? (logs_enabled) => void save({ logs_enabled }) : null}
			>
				<LogStatus connector={connector} nowMs={nowMs} runScript={runScript} />
			</Capability>
			<Capability
				title="Metrics and resources"
				checked={connector.metrics_enabled}
				lock={metricsLock}
				disabled={updating}
				onCheckedChange={isAdmin ? (metrics_enabled) => void save({ metrics_enabled }) : null}
			>
				<MetricsStatus connector={connector} nowMs={nowMs} runScript={runScript} />
			</Capability>
			{pendingChanges.length === 0 ? null : (
				<div className="px-4 pt-1 pb-2">
					<Alert size="sm" role="status">
						<CircleInfoIcon size={14} />
						<AlertTitle>Google Cloud doesn&apos;t match these switches yet</AlertTitle>
						<AlertDescription className="gap-1">
							<p>
								{runScript} It will
								{pendingChanges.length === 1 ? ` ${pendingChanges[0]}.` : ":"}
							</p>
							{pendingChanges.length === 1 ? null : (
								<ul className="list-disc pl-4">
									{pendingChanges.map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
							)}
						</AlertDescription>
						{isAdmin && !setupOpen ? (
							<AlertAction>
								<Button size="xs" variant="outline" onClick={() => setSetupOpen(true)}>
									Show setup script
								</Button>
							</AlertAction>
						) : null}
					</Alert>
				</div>
			)}
			{isAdmin && setupOpen ? (
				<div className="mt-1 -mb-2">
					<GcpSetup connector={connector} nowMs={nowMs} />
				</div>
			) : null}
			{neverReported ? (
				<ConfirmDialog
					open={disconnectOpen}
					onOpenChange={setDisconnectOpen}
					title={`Remove ${label}?`}
					description="The setup script hasn't run, so nothing exists in Google Cloud. This only removes the connection from Maple."
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
		<Panel key={entry.id} padded className="gap-3">
			<div className="flex flex-col gap-1">
				<h3 className="text-sm font-semibold">{entry.label} disconnected</h3>
				<p className="text-xs text-muted-foreground">
					If you haven&apos;t yet, run the cleanup script in Cloud Shell. This stays here until you
					click Done.
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

	if (connectors.length === 0) {
		return (
			<div className="flex flex-col gap-4">
				{cleanup}
				<IntegrationEmpty icon={GoogleCloudIcon} backerIcon={GoogleCloudMonoIcon} accent={GCP_ACCENT}>
					<IntegrationEmptyFeatures>
						<IntegrationEmptyFeature
							label="Logs"
							title="Every Cloud Logging entry"
							description="Cloud Run, GKE, Cloud SQL and audit logs, next to your traces."
						/>
						<IntegrationEmptyFeature
							label="Metrics"
							title="Workloads without agents"
							description="Cloud Run, GKE, Cloud SQL, Pub/Sub and load balancers, read from Cloud Monitoring every 5 minutes."
						/>
						<IntegrationEmptyFeature
							label="Access"
							title="One script, read-only"
							description="You run it in Cloud Shell. No OAuth, no service account keys, no write access for Maple."
						/>
					</IntegrationEmptyFeatures>
					<IntegrationEmptyCard>
						<IntegrationEmptyMedia />
						<IntegrationEmptyHint>
							{isAdmin
								? "Choose what to connect and Maple writes its setup script. You run it in Cloud Shell; it takes about a minute."
								: "A Maple organization admin connects Google Cloud by running a setup script in Cloud Shell."}
						</IntegrationEmptyHint>
						{isAdmin ? (
							<div className="w-full max-w-2xl">
								<GcpConnectForm
									metricsAvailable={metricsAvailable}
									existing={connectors}
									onCreated={() => setAdding(false)}
								/>
							</div>
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
				<Item className="flex-wrap items-start gap-3 rounded-none p-4">
					<ItemMedia>
						<IntegrationIconPlate icon={GoogleCloudIcon} accent={GCP_ACCENT} />
					</ItemMedia>
					<ItemContent className="min-w-48 gap-0">
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
							metricsAvailable={metricsAvailable}
							existing={connectors}
							onCreated={() => setAdding(false)}
							onCancel={() => setAdding(false)}
						/>
					</div>
				) : null}
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
			</Panel>
			{showNotAdmin ? (
				<p className="text-2xs text-muted-foreground">
					Only Maple organization admins can add, change or disconnect connections.
				</p>
			) : null}
		</div>
	)
}
