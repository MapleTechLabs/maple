import { Fragment, useId, useState } from "react"
import type React from "react"
import { Exit, Option } from "effect"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import type { GcpLogFilter, GcpScopeType } from "@maple/domain/primitives"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
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
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Field, FieldDescription, FieldError, FieldLabel } from "@maple/ui/components/ui/field"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { OptionCard } from "@/components/common/option-card"
import { RelativeTime } from "@/components/common/relative-time"
import { REPLAY_BLOCK_CLASS } from "@/components/common/replay-privacy"
import {
	AlertWarningIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleInfoIcon,
	ExternalLinkIcon,
	LockIcon,
} from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { docsUrl } from "@/lib/docs"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { errorMessage, showErrorToast } from "@/lib/error-toast"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	GCP_SCOPE_NAMES,
	cloudShellUrl,
	gcpApplyLine,
	gcpCollectLock,
	gcpCreateRequest,
	gcpDraftEffect,
	gcpLogFilterChoice,
	gcpLogFilters,
	gcpOverlapNote,
	gcpScopeRoles,
	gcpScriptNeeded,
	gcpScriptOverdue,
	gcpSetupRunning,
	isGcpProjectId,
	isGcpResourceNumber,
	logRouterUrl,
	type GcpCapability,
	type GcpCollectLock,
	type GcpConnectorDraft,
	type GcpDraftEffect,
	type GcpFlags,
} from "./gcp-connector-state"
import { gcpStatusQuery } from "./integration-catalog"

export const GCP_REACTIVITY_KEYS = ["gcpIntegration"]
/** Invalidated by a saved configuration: the script depends on what the connector collects. */
const SCRIPT_REACTIVITY_KEYS = ["gcpSetupScripts"]

/** Fast enough to see a script run confirmed, the first data land, or an error clear. */
export const GCP_SETTLING_REFRESH_MS = 10_000

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
	"last-on": "A connection collects at least one of the two. To stop collecting, disconnect.",
	"metrics-unavailable": "Not available on this Maple deployment.",
} as const satisfies { readonly [Lock in GcpCollectLock]: string }

const CAPABILITIES = {
	logs: {
		title: "Log forwarding",
		flag: "logs_enabled",
		description: "A log sink sends Cloud Logging entries to Maple through Pub/Sub.",
		effects: {
			"starts-after-script": "Starts once the script has run in Google Cloud.",
			"resumes-now":
				"Maple stores these logs again as soon as you save. Google Cloud still forwards them.",
			"stops-now":
				"Maple stops storing these logs within about a minute of saving. Google Cloud keeps forwarding them until the script has run.",
			"removed-by-script": "Off in Maple. Google Cloud keeps forwarding until the script has run.",
		},
		now: {
			"stops-now": "Stops storing this connection's logs within about a minute.",
			"resumes-now": "Stores this connection's logs again, at once.",
		},
		later: {
			"stops-now": "Keeps forwarding them to Pub/Sub, billed by Google, until the script has run.",
			"resumes-now": "Nothing to run: the log sink is still there and forwarding.",
		},
	},
	metrics: {
		title: "Metrics and resources",
		flag: "metrics_enabled",
		description:
			"Maple reads Cloud Monitoring every 5 minutes and lists your resources every hour, through a read-only service account.",
		effects: {
			"starts-after-script": "Starts once the script has run in Google Cloud.",
			"resumes-now":
				"Maple reads metrics again from the next 5-minute read. Its service account is still there.",
			"stops-now":
				"Maple stops reading from the next 5-minute read. Its service account stays in Google Cloud until the script has run.",
			"removed-by-script":
				"Off in Maple. Its service account stays in Google Cloud until the script has run.",
		},
		now: {
			"stops-now": "Stops reading this connection's metrics and resources from the next 5-minute read.",
			"resumes-now": "Reads this connection's metrics and resources again from the next 5-minute read.",
		},
		later: {
			"stops-now": "Keeps the read-only service account and its roles until the script has run.",
			"resumes-now": "Nothing to run: the read-only service account is still there.",
		},
	},
} as const satisfies {
	readonly [Capability in GcpCapability]: {
		readonly title: string
		readonly flag: keyof GcpFlags
		readonly description: string
		readonly effects: { readonly [Effect in GcpDraftEffect]: string }
		/** What a choice that acts at once does when it is saved, and what stays until the script runs. */
		readonly now: { readonly [Effect in "stops-now" | "resumes-now"]: string }
		readonly later: { readonly [Effect in "stops-now" | "resumes-now"]: string }
	}
}
const CAPABILITY_IDS: ReadonlyArray<GcpCapability> = ["logs", "metrics"]

/** The page's one link style, the other integrations' (Railway's token link). */
export const GCP_LINK = "underline underline-offset-2 hover:no-underline"
/** Small print: one size, one colour, short lines. */
const SMALL = "text-xs/5 text-pretty text-muted-foreground"
/** A section's or a step's name. On a phone it grows with the controls. */
export const GCP_TITLE = "text-base/6 font-medium sm:text-sm/5"

/** A named link stays on one line. A bare address may break. */
export function GcpExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className={cn(GCP_LINK, children !== href && "whitespace-nowrap")}
		>
			{children}
			{/* A word joiner in a no-wrap span: the icon never wraps away from the last word. */}
			<span className="whitespace-nowrap">
				{"⁠"}
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
 * A shell command to copy: a code chip with its copy button, on one line where the width allows.
 * Too long for its line, it breaks between its words and never inside one: a flag or a name split
 * at a hyphen reads as another.
 */
export function GcpCommand({ children }: { children: string }) {
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
export function GcpOpenCloudShellButton({
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

export function GcpCopyScriptButton({ script, label }: { script: string | null; label: string }) {
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
 * come before the copy button.
 */
function Script({
	script,
	label,
	failure,
	children,
}: {
	script: string | null
	label: string
	failure: { readonly message: string; readonly retry: () => void; readonly retrying: boolean } | null
	children?: React.ReactNode
}) {
	const [shown, setShown] = useState(false)
	const text = script?.trimEnd() ?? null
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				{children}
				<GcpCopyScriptButton script={script} label={label} />
				<button
					type="button"
					aria-expanded={shown}
					onClick={() => setShown(!shown)}
					className={cn(GCP_LINK, "text-xs text-muted-foreground hover:text-foreground")}
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
			<p className={cn(SMALL, "flex items-start gap-1.5")}>
				<LockIcon size={12} className="mt-1 shrink-0" aria-hidden />
				Holds this connection&apos;s secret. Don&apos;t share or commit it.
			</p>
			{!shown || failure !== null ? null : text === null ? (
				<Skeleton className="mt-1 h-72 w-full" />
			) : (
				// The frame of the app's code blocks: a label strip over the text.
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
							"max-h-80 overflow-auto bg-background/50 p-3 font-mono text-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
							REPLAY_BLOCK_CLASS,
						)}
					>
						{text}
					</pre>
				</div>
			)}
		</div>
	)
}

type StepState = "current" | "pending" | "waiting" | "done"

/**
 * One step of a setup or cleanup: a numbered marker on a line that runs to the next step, the
 * title with one line under it, then the controls. Only a step to act on now is bright; one that
 * waits on Google Cloud spins, and a finished one is checked.
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
				state === "done" ? "pb-4" : "pb-6",
			)}
		>
			{state === "done" ? (
				<CircleCheckIcon size={20} className="shrink-0 text-severity-info" aria-hidden />
			) : state === "waiting" ? (
				<Spinner className="size-5 shrink-0 p-0.5 text-muted-foreground" />
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
			<div className="flex min-w-0 flex-1 flex-col gap-2.5">
				<div className="flex flex-col gap-0.5">
					<h4 className={cn(GCP_TITLE, state === "pending" && "text-muted-foreground")}>{title}</h4>
					{detail === undefined ? null : <p className={SMALL}>{detail}</p>}
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
		// `waiting` is the script for the previous filter or configuration, held over while the new
		// one loads. Copying that would set up the wrong thing, so only a settled result counts.
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

/** The log filter the script is asked for, and whether including GKE container logs was confirmed. */
interface FilterState {
	readonly chosen: GcpLogFilter | null
	readonly acknowledged: boolean
}

/**
 * What to collect: one checkbox per capability. Nothing is saved here. `effect` says, for a
 * connection, what saving a choice does and when.
 */
function CollectFields({
	flags,
	onChange,
	metricsAvailable,
	effect,
}: {
	flags: GcpFlags
	onChange: (flags: GcpFlags) => void
	metricsAvailable: boolean
	effect?: (capability: GcpCapability) => GcpDraftEffect | null
}) {
	const id = useId()
	const locks = CAPABILITY_IDS.map((capability) => gcpCollectLock(flags, capability, metricsAvailable))
	return (
		<fieldset className="flex flex-col gap-4">
			<legend className={cn(GCP_TITLE, "mb-3")}>What to collect</legend>
			{CAPABILITY_IDS.map((capability, index) => {
				const { title, flag, description, effects } = CAPABILITIES[capability]
				const note = effect?.(capability) ?? null
				return (
					<Field
						key={capability}
						className="grid grid-cols-[auto_1fr] items-start gap-x-2.5 gap-y-1"
					>
						<Checkbox
							id={`${id}-${capability}`}
							className="mt-px"
							checked={flags[flag]}
							disabled={locks[index] !== null}
							onCheckedChange={(checked) => onChange({ ...flags, [flag]: checked === true })}
						/>
						<FieldLabel htmlFor={`${id}-${capability}`}>{title}</FieldLabel>
						<FieldDescription className="col-start-2 leading-5 text-pretty">
							{locks[index] === "metrics-unavailable"
								? LOCK_NOTES["metrics-unavailable"]
								: description}
						</FieldDescription>
						{note === null ? null : (
							<p className="col-start-2 flex items-start gap-1.5 text-xs/5 text-pretty text-foreground">
								{note === "stops-now" ? (
									<AlertWarningIcon
										size={12}
										className="mt-1 shrink-0 text-severity-warn"
										aria-hidden
									/>
								) : (
									<CircleInfoIcon
										size={12}
										className="mt-1 shrink-0 text-muted-foreground"
										aria-hidden
									/>
								)}
								{effects[note]}
							</p>
						)}
					</Field>
				)
			})}
			{/* A rule of the pair, so it stands under both and not under the one it happens to lock. */}
			{locks.includes("last-on") ? <p className={SMALL}>{LOCK_NOTES["last-on"]}</p> : null}
		</fieldset>
	)
}

/** The filter the script gives the log sink. Including GKE container logs asks to be confirmed. */
function FilterField({
	sinkExists,
	filter,
	onFilter,
	logRouter,
}: {
	sinkExists: boolean
	filter: FilterState
	onFilter: (filter: FilterState) => void
	/** The console page that shows an existing sink's filter. */
	logRouter?: string
}) {
	const checkboxId = useId()
	const filters = gcpLogFilters(sinkExists)
	const choice = gcpLogFilterChoice(filter.chosen, filter.acknowledged, sinkExists)
	// What the choice does, a term and a line each: scanned, not read.
	const lines: ReadonlyArray<readonly [string, React.ReactNode]> = [
		...(choice.selected === "keep"
			? ([
					[
						"Keeps",
						<>
							The filter the sink has now. Maple doesn&apos;t store it
							{logRouter === undefined ? null : (
								<>
									: read it in{" "}
									<GcpExternalLink href={logRouter}>Log Router</GcpExternalLink>
								</>
							)}
							.
						</>,
					],
				] as const)
			: choice.selected === "default"
				? ([
						["Forwards", "Request logs, audit logs and managed-service logs."],
						[
							"Leaves out",
							<>
								<GcpExternalLink href={GKE_LOGS_DOCS}>GKE container logs</GcpExternalLink> and
								high-volume noise such as health checks.
							</>,
						],
					] as const)
				: ([
						["Forwards", "The recommended logs and GKE container logs."],
						["Stored twice", "Logs from workloads that also send them over OpenTelemetry."],
					] as const)),
		...(choice.selected === "keep"
			? []
			: ([
					[
						"Applies",
						sinkExists
							? "When the script runs: it replaces the sink's current filter. Maple doesn't store the choice."
							: "When the script runs. Maple doesn't store the choice.",
					],
				] as const)),
	]
	return (
		<div className="flex flex-col gap-3">
			<Field className="items-stretch gap-1.5">
				<FieldLabel>Log filter</FieldLabel>
				<Select
					items={filters}
					value={choice.selected}
					onValueChange={(chosen) => onFilter({ chosen, acknowledged: false })}
				>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent alignItemWithTrigger={false}>
						{filters.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs/5">
					{lines.map(([term, text]) => (
						<Fragment key={term}>
							<dt className="text-foreground">{term}</dt>
							<dd className="text-pretty text-muted-foreground">{text}</dd>
						</Fragment>
					))}
				</dl>
				<p className="text-xs/5 text-muted-foreground">
					<GcpExternalLink href={`${DOCS}#log-filter`}>Write a filter of your own</GcpExternalLink>
				</p>
			</Field>
			{choice.selected !== "include_gke_container_logs" ? null : (
				<Alert variant="warn" size="sm" role="group" aria-label="GKE container logs">
					<AlertWarningIcon size={14} />
					<AlertTitle>Not recommended when your GKE workloads send traces to Maple</AlertTitle>
					<AlertDescription className="gap-2 leading-5 text-pretty">
						<p>
							Instrumented workloads already send their logs to Maple, linked to their traces.
						</p>
						<p>
							Forwarding the same container logs from Google Cloud stores each line twice, and
							the copy from Google Cloud has no trace link.{" "}
							<GcpExternalLink href={OTEL_DOCS}>
								Google Cloud with OpenTelemetry
							</GcpExternalLink>
						</p>
						<div className="flex items-start gap-2 pt-1 text-foreground">
							<Checkbox
								id={checkboxId}
								className="mt-px"
								checked={filter.acknowledged}
								onCheckedChange={(checked) =>
									onFilter({ ...filter, acknowledged: checked === true })
								}
							/>
							<label htmlFor={checkboxId}>
								I understand that GKE container logs can be stored twice
							</label>
						</div>
						<div>
							<Button
								size="sm"
								variant="outline"
								onClick={() => onFilter({ chosen: null, acknowledged: false })}
							>
								{sinkExists ? "Keep current filter" : "Use recommended filter"}
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			)}
		</div>
	)
}

/** Where the surface is: choosing comes first, then the script applies the choice. */
function Stages({ first, current }: { first: string; current: 0 | 1 }) {
	return (
		<ol className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
			{[first, "Apply in Google Cloud"].map((label, index) => (
				<li
					key={label}
					aria-current={index === current ? "step" : undefined}
					className={cn(
						"flex items-center gap-1.5",
						index === current && "font-medium text-foreground",
					)}
				>
					{index === 0 ? null : (
						<ChevronRightIcon size={12} className="text-muted-foreground" aria-hidden />
					)}
					{label}
				</li>
			))}
		</ol>
	)
}

/**
 * The first stage for a new connection: what to connect and what to collect. Creating it leads
 * into the apply stage, where the script is.
 */
function ConnectStage({
	metricsAvailable,
	existing,
	filter,
	onFilter,
	onCreated,
}: {
	metricsAvailable: boolean
	existing: ReadonlyArray<V2GcpConnector>
	filter: FilterState
	onFilter: (filter: FilterState) => void
	onCreated: (connector: V2GcpConnector) => void
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
	const formId = useId()

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
	const overlap = gcpOverlapNote(draft.scopeType, existing)
	const unacknowledged =
		draft.logsEnabled && gcpLogFilterChoice(filter.chosen, filter.acknowledged, false).unacknowledged

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
			? create({ payload, reactivityKeys: GCP_REACTIVITY_KEYS })
			: create({ payload, reactivityKeys: GCP_REACTIVITY_KEYS }))
		if (Exit.isSuccess(result)) {
			onCreated(result.value)
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
		<>
			<DialogPanel>
				<form
					id={formId}
					onSubmit={handleSubmit}
					className="@container flex w-full flex-col gap-6 text-left"
				>
					<fieldset className="flex flex-col gap-2">
						<legend className={cn(GCP_TITLE, "mb-2")}>What to connect</legend>
						<div className="grid grid-cols-1 gap-2 @lg:grid-cols-3">
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
							<FieldError match className="leading-5 text-pretty">
								{scope.idRule}
							</FieldError>
						) : (
							<FieldDescription className="leading-5 text-pretty">
								<span className="block">
									{aggregated ? (
										<>
											Digits only. In the console: IAM & Admin,{" "}
											<GcpExternalLink href={MANAGE_RESOURCES_URL}>
												Manage resources
											</GcpExternalLink>
										</>
									) : (
										"The ID, not the name or number. The console's project picker lists it."
									)}
								</span>
								<span className="block">
									{scope.listHint} <GcpCommand>{scope.listCommand}</GcpCommand>
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
								<FieldError match className="leading-5 text-pretty">
									{PROJECT_ID_RULE}
								</FieldError>
							) : (
								<FieldDescription className="leading-5 text-pretty">
									Holds Maple&apos;s Pub/Sub topic and read-only service account. Pick a
									project inside the {scopeName} with billing enabled that won&apos;t be
									deleted.
								</FieldDescription>
							)}
						</Field>
					) : null}
					{overlap === null ? null : (
						<Alert size="sm" role="note">
							<CircleInfoIcon size={14} />
							<AlertDescription className="leading-5 text-pretty">{overlap}</AlertDescription>
						</Alert>
					)}
					<div className="flex flex-col gap-4">
						<CollectFields
							flags={{ logs_enabled: draft.logsEnabled, metrics_enabled: draft.metricsEnabled }}
							onChange={(flags) =>
								edit({
									logsEnabled: flags.logs_enabled,
									metricsEnabled: flags.metrics_enabled,
								})
							}
							metricsAvailable={metricsAvailable}
						/>
						{draft.logsEnabled || draft.metricsEnabled ? null : (
							<p className="text-xs text-destructive-foreground" role="alert">
								Choose at least one.
							</p>
						)}
					</div>
					{draft.logsEnabled ? (
						<FilterField sinkExists={false} filter={filter} onFilter={onFilter} />
					) : null}
					{error !== null ? (
						<p className="text-xs text-destructive-foreground" role="alert">
							{error}
						</p>
					) : null}
					<EffectNote />
				</form>
			</DialogPanel>
			<DialogFooter>
				<DialogClose render={<Button variant="outline" disabled={submitting} />}>Cancel</DialogClose>
				<Button
					type="submit"
					form={formId}
					disabled={Option.isNone(request) || unacknowledged}
					loading={submitting}
				>
					Create and continue
				</Button>
			</DialogFooter>
		</>
	)
}

/** When a choice takes effect, said once where the choices are made. */
function EffectNote({ scripted = true }: { scripted?: boolean }) {
	return (
		<p className={cn(SMALL, "flex items-start gap-1.5")}>
			<CircleInfoIcon size={12} className="mt-1 shrink-0" aria-hidden />
			{scripted
				? "Nothing changes in Google Cloud until you run the script in the next step."
				: "Nothing to run after this: Google Cloud still has what it needs."}
		</p>
	)
}

/** The first stage for a connection: what it collects and its log filter. */
function ChooseStage({
	connector,
	metricsAvailable,
	filter,
	onFilter,
	onApply,
}: {
	connector: V2GcpConnector
	metricsAvailable: boolean
	filter: FilterState
	onFilter: (filter: FilterState) => void
	/** Leads into the apply stage, with what was saved if anything changed. */
	onApply: (saved: GcpFlags | null) => void
}) {
	const update = useAtomSet(MapleApiV2AtomClient.mutation("gcpIntegration", "updateConnector"), {
		mode: "promiseExit",
	})
	const [draft, setDraft] = useState<GcpFlags>({
		logs_enabled: connector.logs_enabled,
		metrics_enabled: connector.metrics_enabled,
	})
	const [confirming, setConfirming] = useState(false)
	const sinkExists = connector.applied_logs_enabled === true
	const unacknowledged =
		draft.logs_enabled &&
		gcpLogFilterChoice(filter.chosen, filter.acknowledged, sinkExists).unacknowledged
	const changed = CAPABILITY_IDS.filter(
		(capability) => draft[CAPABILITIES[capability].flag] !== connector[CAPABILITIES[capability].flag],
	)
	const effect = (capability: GcpCapability) =>
		gcpDraftEffect(connector, capability, draft[CAPABILITIES[capability].flag])
	// What acts in Maple the moment it is saved: that asks first.
	const immediate = CAPABILITY_IDS.flatMap((capability) => {
		const acts = effect(capability)
		return acts === "stops-now" || acts === "resumes-now" ? [{ capability, acts }] : []
	})
	const stopping = immediate.filter(({ acts }) => acts === "stops-now")
	// Whether the script has anything to do once this is saved. Turning back on what still exists leaves nothing.
	const scripted = CAPABILITY_IDS.some((capability) => {
		const acts = effect(capability)
		return acts !== null && acts !== "resumes-now"
	})

	// Only what changed is sent: the API leaves an omitted capability as it is, so a stale view of
	// the other cannot overwrite it. Resolving to `false` keeps the confirmation open for a retry.
	const [save, saving] = useAsyncAction(async () => {
		const result = await update({
			params: { id: connector.id },
			payload:
				changed.length === 2
					? draft
					: changed[0] === "logs"
						? { logs_enabled: draft.logs_enabled }
						: { metrics_enabled: draft.metrics_enabled },
			reactivityKeys: [...GCP_REACTIVITY_KEYS, ...SCRIPT_REACTIVITY_KEYS],
		})
		if (Exit.isFailure(result)) {
			showErrorToast(result, { title: "Failed to save the change" })
			return false
		}
		onApply(draft)
		return true
	})

	return (
		<>
			<DialogPanel className="flex flex-col gap-6">
				<CollectFields
					flags={draft}
					onChange={setDraft}
					metricsAvailable={metricsAvailable}
					effect={effect}
				/>
				{draft.logs_enabled ? (
					<FilterField
						sinkExists={sinkExists}
						filter={filter}
						onFilter={onFilter}
						logRouter={logRouterUrl(connector)}
					/>
				) : null}
				<EffectNote scripted={changed.length === 0 || scripted} />
			</DialogPanel>
			<DialogFooter>
				<DialogClose render={<Button variant="outline" disabled={saving} />}>Cancel</DialogClose>
				<Button
					disabled={unacknowledged}
					loading={saving && !confirming}
					onClick={() =>
						changed.length === 0
							? onApply(null)
							: immediate.length > 0
								? setConfirming(true)
								: void save()
					}
				>
					{changed.length === 0
						? "Continue to the script"
						: scripted
							? "Save and continue"
							: "Save"}
				</Button>
			</DialogFooter>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				tone={stopping.length > 0 ? "destructive" : "default"}
				icon={stopping.length > 0 ? undefined : null}
				title={
					<>
						{`Turn ${(stopping.length > 0 ? stopping : immediate)
							.map(({ capability }) => CAPABILITIES[capability].title.toLowerCase())
							.join(" and ")} ${stopping.length > 0 ? "off" : "back on"}`}{" "}
						for {GCP_SCOPE_NAMES[connector.scope_type]}{" "}
						<span className="whitespace-nowrap">{connector.scope_id}</span>?
					</>
				}
				// Turning off leaves something for the script to remove; turning back on leaves nothing to run.
				confirmLabel={stopping.length > 0 ? "Turn off and continue" : "Turn on"}
				onConfirm={save}
			>
				<dl className="flex flex-col gap-3 pb-3 text-sm">
					<div>
						<dt className="font-medium">In Maple</dt>
						{immediate.map(({ capability, acts }) => (
							<dd key={capability} className="text-pretty text-muted-foreground">
								{CAPABILITIES[capability].now[acts]}
							</dd>
						))}
					</div>
					<div>
						<dt className="font-medium">In Google Cloud</dt>
						{immediate.map(({ capability, acts }) => (
							<dd key={capability} className="text-pretty text-muted-foreground">
								{CAPABILITIES[capability].later[acts]}
							</dd>
						))}
					</div>
				</dl>
			</ConfirmDialog>
		</>
	)
}

/**
 * When a connection's apply stage was entered. `rerun`: nobody has said a run is under way, so
 * the stage stays open until a newer run reports and its last step does not time one.
 */
interface ApplyOpened {
	readonly at: number
	readonly rerun: boolean
	/** The report on record at that moment: a different one is a newer run. */
	readonly seen: string | null
}

/** The second stage: the script that applies the configuration, and Maple's confirmation. */
function ApplyStage({
	connector,
	filter,
	nowMs,
	opened,
	onBack,
	onClose,
}: {
	connector: V2GcpConnector
	filter: FilterState
	nowMs: number
	opened: ApplyOpened
	onBack: () => void
	onClose: () => void
}) {
	const sinkExists = connector.applied_logs_enabled === true
	const choice = gcpLogFilterChoice(filter.chosen, filter.acknowledged, sinkExists)
	const { scripts, failure } = useGcpScripts(connector, choice.scriptFilter)
	const refresh = useAtomRefresh(gcpStatusQuery())

	const reportedAt = connector.setup_reported_at
	// A run's sections report one after the other: confirmed once the last one has.
	const confirmed =
		gcpScriptNeeded(connector, nowMs) === null &&
		!gcpSetupRunning(connector, nowMs) &&
		(!opened.rerun || reportedAt !== opened.seen)
	useIntervalRefresh(refresh, { intervalMs: GCP_SETTLING_REFRESH_MS, enabled: !confirmed })
	const overdue = !opened.rerun && gcpScriptOverdue(connector, opened.at, nowMs)

	const scopeRoles = gcpScopeRoles(connector.scope_type, connector)
	const scopeName = GCP_SCOPE_NAMES[connector.scope_type].toLowerCase()
	const role = (name: string) => <span className="text-foreground">{name}</span>

	return (
		<>
			<DialogPanel className="flex flex-col gap-5">
				{/* What is saved and what this run does about it, so the script is never a black box. */}
				<dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 rounded-md border border-border/60 bg-muted/40 px-3 py-2.5 text-xs/5 sm:grid-cols-[auto_1fr] [&>dd]:text-pretty [&>dd]:max-sm:mb-1.5 [&>dt]:text-muted-foreground">
					<dt>Log forwarding</dt>
					<dd>{gcpApplyLine(connector.logs_enabled, connector.applied_logs_enabled)}</dd>
					{connector.logs_enabled && !confirmed ? (
						<>
							<dt>Log filter</dt>
							<dd>
								{choice.scriptFilter === "keep"
									? "Kept: the sink's current filter"
									: gcpLogFilters(sinkExists).find(
											(option) => option.value === choice.scriptFilter,
										)?.label}
							</dd>
						</>
					) : null}
					<dt>Metrics and resources</dt>
					<dd>{gcpApplyLine(connector.metrics_enabled, connector.applied_metrics_enabled)}</dd>
				</dl>
				{confirmed ? (
					<Alert variant="ok" size="sm" role="status">
						<CircleCheckIcon size={14} />
						<AlertTitle>Google Cloud matches this configuration</AlertTitle>
						<AlertDescription>
							{reportedAt === null ? (
								"Maple confirmed the run."
							) : (
								<span>
									<RelativeTime value={reportedAt} prefix="Maple confirmed the last run" />.
								</span>
							)}
						</AlertDescription>
					</Alert>
				) : (
					<ol>
						<Step
							number={1}
							state="current"
							title="Open Cloud Shell"
							detail={
								<>
									Sign in as an {role("Owner")} of{" "}
									{connector.scope_type === "project" ? null : "the host project "}
									<Mono>{connector.project_id}</Mono>
									{scopeRoles.map((name, index) => (
										<Fragment key={name}>
											{index === 0 ? " who also has " : " and "}
											{role(name)}
										</Fragment>
									))}
									{scopeRoles.length > 0 ? ` on the ${scopeName}` : null}.{" "}
									<GcpExternalLink href={`${DOCS}#roles-for-running-the-script`}>
										Roles if you aren&apos;t an Owner
									</GcpExternalLink>
								</>
							}
						>
							<div>
								<GcpOpenCloudShellButton projectId={connector.project_id} />
							</div>
						</Step>
						<Step
							number={2}
							state="current"
							title="Paste the script and press Enter"
							detail={
								!connector.logs_enabled && sinkExists
									? "Takes one to two minutes: after deleting the sink it waits for Google to stop routing."
									: "Takes about a minute. Safe to run again."
							}
						>
							<Script script={scripts?.setup_script ?? null} label="script" failure={failure} />
						</Step>
						<Step
							number={3}
							state={overdue ? "current" : "waiting"}
							title={overdue ? "Maple has no confirmation yet" : "Maple is waiting for the run"}
							detail={
								overdue ? undefined : opened.rerun && reportedAt !== null ? (
									<>
										This updates on its own.{" "}
										<RelativeTime
											value={reportedAt}
											prefix="The last run was confirmed"
										/>
										.
									</>
								) : (
									"This updates on its own, within a minute of the script ending."
								)
							}
						>
							{overdue ? (
								<ul className="list-disc pl-4 text-xs/5 text-pretty text-muted-foreground">
									<li>
										<span className="text-foreground">
											If the script stopped with an error,
										</span>{" "}
										fix what it names and paste it again. It continues where it stopped.
									</li>
									<li>
										<span className="text-foreground">If the ID is wrong,</span>{" "}
										disconnect this connection and connect the right one. An ID can&apos;t
										be changed.
									</li>
								</ul>
							) : null}
							{overdue ? (
								<p className="text-xs/5">
									<GcpExternalLink href={`${DOCS}#troubleshooting`}>
										Troubleshooting
									</GcpExternalLink>
								</p>
							) : null}
						</Step>
					</ol>
				)}
			</DialogPanel>
			{confirmed ? (
				<DialogFooter>
					<Button onClick={onClose}>Done</Button>
				</DialogFooter>
			) : (
				<DialogFooter className="sm:justify-between">
					<Button variant="outline" onClick={onBack}>
						Edit configuration
					</Button>
					<Button variant="outline" onClick={onClose}>
						Close
					</Button>
				</DialogFooter>
			)}
		</>
	)
}

/** What the configuration surface is open on. */
export type GcpConfigureTarget =
	| { readonly kind: "new" }
	| { readonly kind: "connection"; readonly id: string; readonly stage: "choose" | "apply" }

/** A connection's two stages. Admin-only: fetching the script is refused for everyone else. */
function ConnectionStages({
	connector: saved,
	created,
	initialStage,
	metricsAvailable,
	filter,
	onFilter,
	nowMs,
	onStage,
	onClose,
}: {
	connector: V2GcpConnector
	/** Created in this surface a moment ago: the script has not run and a run is expected. */
	created: boolean
	initialStage: "choose" | "apply"
	metricsAvailable: boolean
	filter: FilterState
	onFilter: (filter: FilterState) => void
	nowMs: number
	onStage: (stage: "choose" | "apply") => void
	onClose: () => void
}) {
	// What was just saved, shown until the status read delivers a newer connector. Without it the
	// apply stage would read the old configuration for the length of the refetch.
	const [asked, setAsked] = useState<{ readonly of: V2GcpConnector; readonly flags: GcpFlags } | null>(null)
	const connector = asked !== null && asked.of === saved ? { ...saved, ...asked.flags } : saved
	const open = (rerun: boolean): ApplyOpened => ({
		at: Date.now(),
		rerun,
		seen: saved.setup_reported_at,
	})
	// Found waiting on a first run, the last step times it from the connection's creation. Found
	// any other way, nobody has said a run is under way.
	const [opened, setOpened] = useState<ApplyOpened | null>(() =>
		initialStage === "apply"
			? open(!created && gcpScriptNeeded(saved, Date.now()) !== "setup-pending")
			: null,
	)

	return opened === null ? (
		<ChooseStage
			connector={connector}
			metricsAvailable={metricsAvailable}
			filter={filter}
			onFilter={onFilter}
			onApply={(flags) => {
				if (flags !== null) setAsked({ of: saved, flags })
				setOpened(open(flags === null))
				onStage("apply")
			}}
		/>
	) : (
		<ApplyStage
			connector={connector}
			filter={filter}
			nowMs={nowMs}
			opened={opened}
			onBack={() => {
				setOpened(null)
				onStage("choose")
			}}
			onClose={onClose}
		/>
	)
}

/**
 * The one place a connection is configured: what to collect, the log filter, then the script that
 * applies it in Google Cloud. A new connection goes through the same two stages.
 */
export function GcpConfigure({
	target,
	connectors,
	metricsAvailable,
	nowMs,
	onCreated,
	onClose,
}: {
	target: GcpConfigureTarget
	connectors: ReadonlyArray<V2GcpConnector>
	metricsAvailable: boolean
	nowMs: number
	onCreated: (connector: V2GcpConnector) => void
	onClose: () => void
}) {
	// Not saved: the script is asked for with it. Reopening the surface starts over.
	const [filter, setFilter] = useState<FilterState>({ chosen: null, acknowledged: false })
	const [stage, setStage] = useState<"choose" | "apply">(target.kind === "new" ? "choose" : target.stage)
	// The connector the surface created, until the status read lists it.
	const [created, setCreated] = useState<V2GcpConnector | null>(null)
	const connector =
		target.kind === "new"
			? undefined
			: (connectors.find((candidate) => candidate.id === target.id) ??
				(created?.id === target.id ? created : undefined))

	return (
		<Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="pr-8">
						{connector === undefined ? (
							connectors.length === 0 ? (
								"Connect Google Cloud"
							) : (
								"Add connection"
							)
						) : (
							<>
								{GCP_SCOPE_NAMES[connector.scope_type]}{" "}
								<span className="whitespace-nowrap">{connector.scope_id}</span>
							</>
						)}
					</DialogTitle>
					<Stages
						first={
							connector === undefined || created?.id === connector.id ? "Connect" : "Configure"
						}
						current={stage === "apply" ? 1 : 0}
					/>
				</DialogHeader>
				{/* Each stage brings its own panel and footer. */}
				{target.kind !== "new" && connector === undefined ? (
					<DialogPanel>
						<Skeleton className="h-40 w-full" />
					</DialogPanel>
				) : connector === undefined ? (
					<ConnectStage
						metricsAvailable={metricsAvailable}
						existing={connectors}
						filter={filter}
						onFilter={setFilter}
						onCreated={(connector) => {
							setCreated(connector)
							setStage("apply")
							onCreated(connector)
						}}
					/>
				) : (
					<ConnectionStages
						key={connector.id}
						connector={connector}
						created={created?.id === connector.id}
						initialStage={stage}
						metricsAvailable={metricsAvailable}
						filter={filter}
						onFilter={setFilter}
						nowMs={nowMs}
						onStage={setStage}
						onClose={onClose}
					/>
				)}
			</DialogContent>
		</Dialog>
	)
}

/**
 * Disconnecting a connection whose script has run: clean Google Cloud up first, then remove the
 * connection. The cleanup script reports to Maple, so the dialog sees it finish.
 */
export function GcpDisconnectDialog({
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
	useIntervalRefresh(useAtomRefresh(gcpStatusQuery()), {
		intervalMs: GCP_SETTLING_REFRESH_MS,
		enabled: true,
	})
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
									`Run the cleanup script in Cloud Shell. Takes ${connector.applied_logs_enabled === true ? "one to two minutes" : "about a minute"}.`
								)
							}
						>
							{cleaned ? null : (
								<>
									<dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs/5">
										<dt className="text-foreground">Deletes</dt>
										<dd className="text-pretty text-muted-foreground">
											The log sink, topic, subscription and read-only service account.
										</dd>
										<dt className="text-foreground">Keeps</dt>
										<dd className="text-muted-foreground">The APIs it switched on.</dd>
									</dl>
									<Script
										script={scripts?.cleanup_script ?? null}
										label="cleanup script"
										failure={failure}
									>
										<GcpOpenCloudShellButton projectId={connector.project_id} />
									</Script>
									<p className={cn(SMALL, "text-foreground/80")}>
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
					{cleaned ? null : (
						<p className={cn(SMALL, "mt-4 flex items-start gap-1.5 text-foreground")}>
							<AlertWarningIcon
								size={12}
								className="mt-1 shrink-0 text-severity-warn"
								aria-hidden
							/>
							Disconnecting before the cleanup leaves Google Cloud publishing logs to Pub/Sub,
							billed by Google.
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
