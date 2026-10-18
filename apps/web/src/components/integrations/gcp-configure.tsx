import { Fragment, useId, useState } from "react"
import type React from "react"
import { Exit, Option } from "effect"
import { gcpSetupPlan } from "@maple/domain/gcp"
import type { V2GcpConnector, V2GcpSetupScripts } from "@maple/domain/http/v2"
import type { GcpLogRuntime, GcpScopeType } from "@maple/domain/primitives"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
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
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Switch } from "@maple/ui/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { useCopy } from "@maple/ui/hooks/use-copy"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { RelativeTime } from "@/components/common/relative-time"
import { REPLAY_BLOCK_CLASS } from "@/components/common/replay-privacy"
import {
	AlertWarningIcon,
	CheckIcon,
	ChevronDownIcon,
	CircleCheckIcon,
	CircleInfoIcon,
	ExternalLinkIcon,
	GoogleCloudIcon,
	LockIcon,
} from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { docsUrl } from "@/lib/docs"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { errorMessage, showErrorToast } from "@/lib/error-toast"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	GCP_LOG_STATUS,
	GCP_METRICS_STATUS,
	GCP_LOG_RUNTIMES,
	GCP_SCOPE_NAMES,
	cloudShellUrl,
	gcpCollectLock,
	gcpCreateRequest,
	gcpDraftEffect,
	gcpLogFilterChoice,
	gcpLogState,
	gcpMetricsState,
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
	type GcpLogFilterDraft,
} from "./gcp-connector-state"
import {
	GCP_LINK,
	GCP_SMALL as SMALL,
	GCP_TITLE,
	GcpCommand,
	GcpExternalLink,
	GcpMono as Mono,
} from "./gcp-primitives"
import { GcpManualSteps, GcpMethodChoice, GcpValue } from "./gcp-setup-methods"
import {
	gcpAgentPrompt,
	gcpAlchemyUnavailable,
	gcpManualSteps,
	gcpRemovalList,
	type GcpSetupMethod,
} from "./gcp-setup-steps"
import { gcpStatusQuery } from "./integration-catalog"

export const GCP_REACTIVITY_KEYS = ["gcpIntegration"]
/** Invalidated by a saved configuration: the script depends on what the connector collects. */
const SCRIPT_REACTIVITY_KEYS = ["gcpSetupScripts"]

/** Fast enough to see a script run confirmed, the first data land, or an error clear. */
export const GCP_SETTLING_REFRESH_MS = 10_000

const DOCS = docsUrl("gcp")
const OTEL_DOCS = docsUrl("gcpOpenTelemetry")
const MANUAL_DOCS = docsUrl("gcpManualSetup")
const IAC_DOCS = docsUrl("gcpInfrastructureAsCode")

const PROJECT_ID_RULE =
	"A project ID is 6 to 30 lowercase letters, digits and hyphens. It starts with a letter and can't end with a hyphen. The project name and number don't work."

/** The scope choices, in display order: most connect one project. */
const SCOPES = {
	project: {
		description: "One project.",
		idLabel: "Project ID",
		idRule: PROJECT_ID_RULE,
		placeholder: "acme-prod",
		hint: "The ID, not the name or number.",
		listCommand: "gcloud projects list",
	},
	folder: {
		description: "Every project in the folder, including new ones.",
		idLabel: "Folder ID",
		idRule: "A folder ID is digits only, such as 123456789012.",
		placeholder: "123456789012",
		hint: "Digits only, with your organization's ID in place of ORGANIZATION_ID.",
		listCommand: "gcloud resource-manager folders list --organization=ORGANIZATION_ID",
	},
	organization: {
		description: "Every project in the organization, including new ones.",
		idLabel: "Organization ID",
		idRule: "An organization ID is digits only, such as 123456789012.",
		placeholder: "123456789012",
		hint: "Digits only.",
		listCommand: "gcloud organizations list",
	},
} as const
const SCOPE_TYPES: ReadonlyArray<GcpScopeType> = ["project", "folder", "organization"]

const LOCK_NOTES = {
	"last-on": "A connection collects at least one of the two. To stop collecting, disconnect.",
	"metrics-unavailable": "Not available on this Maple deployment.",
} as const satisfies { readonly [Lock in GcpCollectLock]: string }

const CAPABILITIES = {
	logs: {
		title: "Log forwarding",
		flag: "logs_enabled",
		description: "Request, audit and managed-service logs, through a Log Router sink and Pub/Sub.",
		run: { on: "Log sink and Pub/Sub topic", off: "Removes the log sink" },
		effects: {
			"starts-after-script": "Starts once it's set up in Google Cloud",
			"resumes-now": "Stored again as soon as you save",
			"stops-now": "Maple stops storing them when you save",
			"removed-by-script": "Still forwarded by Google Cloud until the change is applied there",
		},
		now: {
			"stops-now": "Stops storing this connection's logs within about a minute.",
			"resumes-now": "Stores this connection's logs again, at once.",
		},
		later: {
			"stops-now": "Keeps forwarding them to Pub/Sub, billed by Google, until the change is applied in Google Cloud.",
			"resumes-now": "Nothing to apply: the log sink is still there and forwarding.",
		},
	},
	metrics: {
		title: "Metrics and resources",
		flag: "metrics_enabled",
		description:
			"Cloud Run, GKE, Compute Engine, Cloud SQL, Pub/Sub, Load Balancing and Cloud Functions. Read-only, every 5 minutes.",
		run: { on: "Read-only service account", off: "Removes the service account" },
		effects: {
			"starts-after-script": "Starts once it's set up in Google Cloud",
			"resumes-now": "Read again from the next 5-minute read",
			"stops-now": "Maple stops reading when you save",
			"removed-by-script": "Its service account stays in Google Cloud until the change is applied there",
		},
		now: {
			"stops-now": "Stops reading this connection's metrics and resources from the next 5-minute read.",
			"resumes-now": "Reads this connection's metrics and resources again from the next 5-minute read.",
		},
		later: {
			"stops-now": "Keeps the read-only service account and its roles until the change is applied in Google Cloud.",
			"resumes-now": "Nothing to apply: the read-only service account is still there.",
		},
	},
} as const satisfies {
	readonly [Capability in GcpCapability]: {
		readonly title: string
		readonly flag: keyof GcpFlags
		readonly description: string
		/** What the script sets up for it, or removes, in the run step's status. */
		readonly run: { readonly on: string; readonly off: string }
		readonly effects: { readonly [Effect in GcpDraftEffect]: string }
		/** What a choice that acts at once does when it is saved, and what stays until the script runs. */
		readonly now: { readonly [Effect in "stops-now" | "resumes-now"]: string }
		readonly later: { readonly [Effect in "stops-now" | "resumes-now"]: string }
	}
}
const CAPABILITY_IDS: ReadonlyArray<GcpCapability> = ["logs", "metrics"]

/** The name over a group of controls. */
const LABEL = "text-xs font-medium text-muted-foreground"

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
					<ExternalLinkIcon />
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
	failure: ScriptFailure | null
	children?: React.ReactNode
}) {
	const [shown, setShown] = useState(false)
	const text = script?.trimEnd() ?? null
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				{children}
				<GcpCopyScriptButton script={script} label={label} />
				<Button
					variant="link"
					size="xs"
					aria-expanded={shown}
					onClick={() => setShown(!shown)}
					className={cn(
						"h-auto p-0 font-normal text-xs text-muted-foreground hover:text-foreground",
						GCP_LINK,
					)}
				>
					{shown ? "Hide the script" : "Read the script"}
				</Button>
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
function useGcpScripts(
	connector: V2GcpConnector,
	/** The runtimes whose application output the sink forwards; undefined keeps the sink's filter. */
	applicationLogs: ReadonlyArray<GcpLogRuntime> | undefined,
) {
	const query = MapleApiV2AtomClient.query("gcpIntegration", "setupScripts", {
		params: { id: connector.id },
		payload: applicationLogs === undefined ? {} : { application_logs: applicationLogs },
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

export interface ScriptFailure {
	readonly message: string
	readonly retry: () => void
	readonly retrying: boolean
}

/** The log filter the script is asked for. */
type FilterState = GcpLogFilterDraft

/** What an existing sink's filter can be left as or replaced with. */
const FILTER_MODES = [
	{ value: "keep", label: "Keep current filter", hint: "Leaves the sink as it is" },
	{ value: "set", label: "Replace filter", hint: "Sets the filter below" },
] as const

const STEPS = ["Scope", "Data", "Method", "Set up"] as const
/** The step the flow is on. */
type StepIndex = 0 | 1 | 2 | 3

/** Where the flow is: done steps are checked, the current one is filled, later ones are outlined. */
function Stepper({ current }: { current: StepIndex }) {
	return (
		<ol className="flex items-center gap-3 text-sm">
			{STEPS.map((label, index) => {
				const done = index < current
				const active = index === current
				return (
					<li
						key={label}
						aria-current={active ? "step" : undefined}
						className={cn("flex items-center gap-3", index > 0 && "flex-1")}
					>
						{index === 0 ? null : (
							<span
								aria-hidden
								className={cn(
									"h-px flex-1",
									done || active ? "bg-foreground/24" : "bg-border",
								)}
							/>
						)}
						<span className="flex shrink-0 items-center gap-2">
							<span
								aria-hidden
								className={cn(
									"flex size-5 items-center justify-center rounded-full text-2xs font-medium tabular-nums",
									done
										? "bg-severity-info/16 text-severity-info"
										: active
											? "bg-primary text-primary-foreground"
											: "border border-input text-muted-foreground",
								)}
							>
								{done ? <CheckIcon size={12} /> : index + 1}
							</span>
							<span
								className={cn(
									active
										? "font-medium text-foreground"
										: done
											? "text-foreground"
											: "text-muted-foreground",
								)}
							>
								{label}
								{done ? <span className="sr-only"> (done)</span> : null}
							</span>
						</span>
					</li>
				)
			})}
		</ol>
	)
}

/** `step` is undefined once every step is done: the finished flow shows no stepper. */
function ConfigureHeader({ title, step }: { title: React.ReactNode; step?: StepIndex }) {
	return (
		<DialogHeader className="gap-5">
			<DialogTitle className="flex items-center gap-3 pr-8">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/60">
					<GoogleCloudIcon size={18} />
				</span>
				<span className="min-w-0">{title}</span>
			</DialogTitle>
			{step === undefined ? null : <Stepper current={step} />}
		</DialogHeader>
	)
}

/** One short line at the footer's start: why the action waits, or what closing leaves behind. */
function FooterNote({ children }: { children: React.ReactNode }) {
	return <p className="text-xs/5 text-pretty text-muted-foreground sm:mr-auto sm:self-center">{children}</p>
}

/**
 * What to collect: a switch per capability, with the log filter under Logs. Nothing is saved here.
 * `effect` says, for a connection, what saving a choice does and when.
 */
function CollectFields({
	flags,
	onChange,
	metricsAvailable,
	effect,
	logFilter,
}: {
	flags: GcpFlags
	onChange: (flags: GcpFlags) => void
	metricsAvailable: boolean
	effect?: (capability: GcpCapability) => GcpDraftEffect | null
	logFilter: React.ReactNode
}) {
	const id = useId()
	const locks = CAPABILITY_IDS.map((capability) => gcpCollectLock(flags, capability, metricsAvailable))
	return (
		<fieldset className="flex flex-col gap-3">
			<legend className={cn(GCP_TITLE, "mb-3")}>What should Maple collect?</legend>
			<div className="divide-y divide-border/60 rounded-lg border">
				{CAPABILITY_IDS.map((capability, index) => {
					const { title, flag, description, effects } = CAPABILITIES[capability]
					const note = effect?.(capability) ?? null
					return (
						<div key={capability} className="flex flex-col gap-3 p-4">
							<div className="flex items-start gap-4">
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<label htmlFor={`${id}-${capability}`} className="text-sm font-medium">
										{title}
									</label>
									<p className={SMALL}>
										{locks[index] === "metrics-unavailable"
											? LOCK_NOTES["metrics-unavailable"]
											: description}
									</p>
									{note === null ? null : (
										<p className="flex items-start gap-1.5 text-xs/5 text-pretty text-foreground">
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
								</div>
								<Switch
									id={`${id}-${capability}`}
									checked={flags[flag]}
									disabled={locks[index] !== null}
									onCheckedChange={(checked) => onChange({ ...flags, [flag]: checked })}
								/>
							</div>
							{capability === "logs" && flags.logs_enabled ? logFilter : null}
						</div>
					)
				})}
			</div>
			{/* A rule of the pair, so it stands under both and not under the one it happens to lock. */}
			{locks.includes("last-on") ? <p className={SMALL}>{LOCK_NOTES["last-on"]}</p> : null}
		</fieldset>
	)
}

/** The log filter's choice in a few words: the closed disclosure and the run summary. */
const filterShort = (choice: ReturnType<typeof gcpLogFilterChoice>) =>
	choice.keep
		? "Current filter"
		: choice.runtimes.length === 0
			? "Platform logs"
			: `Platform logs + ${runtimeLabels(choice.runtimes)}`

/** The log filter under Logs, closed on its current choice. */
function LogFilter({
	sinkExists,
	filter,
	onFilter,
	logRouter,
}: {
	sinkExists: boolean
	filter: FilterState
	onFilter: (filter: FilterState) => void
	logRouter?: string
}) {
	const [open, setOpen] = useState(false)
	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="rounded-md border border-border/60 bg-muted/32"
		>
			<CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
				<span className="text-foreground">Log filter</span>
				<span className="truncate text-muted-foreground">
					{filterShort(gcpLogFilterChoice(filter, sinkExists))}
				</span>
				<ChevronDownIcon
					size={12}
					className="ml-auto shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
					aria-hidden
				/>
			</CollapsibleTrigger>
			<CollapsiblePanel className="border-t border-border/60 p-3">
				<GcpLogFilterField
					sinkExists={sinkExists}
					filter={filter}
					onFilter={onFilter}
					logRouter={logRouter}
					showLabel={false}
				/>
			</CollapsiblePanel>
		</Collapsible>
	)
}

/**
 * The filter the script gives the log sink: whose application output comes with the platform logs,
 * a tick per runtime. A sink that exists keeps its filter unless asked to replace it.
 */
export function GcpLogFilterField({
	sinkExists,
	filter,
	onFilter,
	logRouter,
	showLabel = true,
}: {
	sinkExists: boolean
	filter: FilterState
	onFilter: (filter: FilterState) => void
	/** The console page that shows an existing sink's filter. */
	logRouter?: string
	/** False inside a disclosure that already names the filter. */
	showLabel?: boolean
}) {
	const id = useId()
	const choice = gcpLogFilterChoice(filter, sinkExists)
	return (
		<Field className="items-stretch gap-2.5">
			<div className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground">
				{showLabel ? (
					<FieldLabel className={cn(LABEL, "sm:text-xs/4")}>Log filter</FieldLabel>
				) : (
					<span />
				)}
				{choice.keep && logRouter !== undefined ? (
					// Maple doesn't store a sink's filter: the console shows it.
					<GcpExternalLink href={logRouter}>Current filter in Log Router</GcpExternalLink>
				) : (
					<GcpExternalLink href={`${DOCS}#log-filter`}>Custom filter</GcpExternalLink>
				)}
			</div>
			{sinkExists ? (
				<Select
					items={FILTER_MODES}
					value={choice.keep ? "keep" : "set"}
					onValueChange={(mode) => onFilter({ ...filter, keep: mode === "keep" })}
				>
					<SelectTrigger className="w-full">
						<SelectValue>
							{(value: (typeof FILTER_MODES)[number]["value"]) => (
								<FilterMode mode={FILTER_MODES.find((mode) => mode.value === value)} />
							)}
						</SelectValue>
					</SelectTrigger>
					<SelectContent alignItemWithTrigger={false}>
						{FILTER_MODES.map((mode) => (
							<SelectItem key={mode.value} value={mode.value}>
								<FilterMode mode={mode} />
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : null}
			{choice.keep ? null : (
				<div className="flex flex-col gap-2.5">
					<dl className="divide-y rounded-md border">
						<FilterSummaryRow
							icon={<CheckIcon size={14} aria-hidden className="text-severity-info" />}
							term="Platform logs"
							detail="Requests, audit, deploys, crashes, scaling"
						/>
						<FilterSummaryRow
							icon={<span aria-hidden>–</span>}
							term="Application output"
							detail={
								choice.runtimes.length === 0
									? "stdout and stderr, left in Google Cloud"
									: `stdout and stderr, from ${runtimeLabels(choice.runtimes)} only`
							}
						/>
					</dl>
					<p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs/5 text-pretty text-muted-foreground">
						Send application logs with your OpenTelemetry setup, where they link to traces.
						<GcpExternalLink href={OTEL_DOCS}>Set up OpenTelemetry</GcpExternalLink>
					</p>
					{choice.forwardsOutput ? (
						<RuntimeFields
							id={id}
							filter={filter}
							runtimes={choice.runtimes}
							onFilter={onFilter}
						/>
					) : (
						// The ticks are an escape hatch: a workload sending over OpenTelemetry would store each line twice.
						<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-1">
							<span className="text-xs/5 text-muted-foreground">
								No way to add OpenTelemetry to a workload?
							</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() => onFilter({ ...filter, runtimes: [] })}
							>
								Can&apos;t forward via OpenTelemetry
							</Button>
						</div>
					)}
				</div>
			)}
		</Field>
	)
}

/** One line of what the new filter forwards. */
function FilterSummaryRow({ icon, term, detail }: { icon: React.ReactNode; term: string; detail: string }) {
	return (
		<div className="grid grid-cols-[1rem_1fr] items-center gap-x-3 gap-y-0.5 px-3.5 py-2.5 sm:grid-cols-[1rem_11.875rem_1fr]">
			<span className="flex justify-center text-muted-foreground">{icon}</span>
			<dt className="text-sm/5 font-medium">{term}</dt>
			<dd className="col-start-2 text-xs text-pretty text-muted-foreground sm:col-start-3">{detail}</dd>
		</div>
	)
}

const runtimeLabels = (runtimes: ReadonlyArray<GcpLogRuntime>) =>
	GCP_LOG_RUNTIMES.filter(({ value }) => runtimes.includes(value))
		.map(({ label }) => label)
		.join(", ")

/** The runtimes whose application output Google Cloud forwards, once OpenTelemetry is ruled out. */
function RuntimeFields({
	id,
	filter,
	runtimes,
	onFilter,
}: {
	id: string
	filter: FilterState
	runtimes: ReadonlyArray<GcpLogRuntime>
	onFilter: (filter: FilterState) => void
}) {
	return (
		<fieldset aria-labelledby={`${id}-forward`} className="flex flex-col gap-2.5 pt-1">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs/5">
				<span id={`${id}-forward`} className="font-medium">
					Forward application output from Google Cloud
				</span>
				<Button
					variant="link"
					size="xs"
					onClick={() => onFilter({ ...filter, runtimes: null })}
					className={cn(
						"h-auto p-0 font-normal text-xs text-muted-foreground hover:text-foreground",
						GCP_LINK,
					)}
				>
					Use OpenTelemetry instead
				</Button>
			</div>
			<div className="divide-y rounded-md border">
				{GCP_LOG_RUNTIMES.map(({ value, label, hint }) => (
					<Field
						key={value}
						className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-0.5 px-3.5 py-2.5 sm:grid-cols-[auto_11.875rem_1fr]"
					>
						<Checkbox
							id={`${id}-${value}`}
							checked={runtimes.includes(value)}
							onCheckedChange={(checked) =>
								onFilter({
									...filter,
									runtimes:
										checked === true
											? [...runtimes, value]
											: runtimes.filter((runtime) => runtime !== value),
								})
							}
						/>
						<FieldLabel htmlFor={`${id}-${value}`} className="sm:text-sm/5">
							{label}
						</FieldLabel>
						<FieldDescription className="col-start-2 text-pretty sm:col-start-3">
							{hint}
						</FieldDescription>
					</Field>
				))}
			</div>
			{/* Maple does not know which workloads send their logs another way: the call is the admin's. */}
			<Alert variant="warn" size="sm" role="note">
				<AlertWarningIcon size={14} />
				<AlertTitle>Only for workloads that don&apos;t send logs over OpenTelemetry</AlertTitle>
				<AlertDescription className="leading-5 text-pretty">
					Otherwise every line arrives twice, both count toward your plan, and the Google Cloud copy
					has no trace link.{" "}
					<GcpExternalLink href={`${OTEL_DOCS}#application-output`}>Details</GcpExternalLink>
				</AlertDescription>
			</Alert>
		</fieldset>
	)
}

/** What happens to an existing sink's filter, by name, with what that does beside it. */
function FilterMode({ mode }: { mode: (typeof FILTER_MODES)[number] | undefined }) {
	if (mode === undefined) return null
	return (
		<span className="flex min-w-0 items-baseline gap-2.5">
			<span className="shrink-0 font-medium">{mode.label}</span>
			<span className="truncate text-xs text-muted-foreground">{mode.hint}</span>
		</span>
	)
}

/** The scope step: what kind of thing to connect, and its ID. */
function ScopeFields({
	draft,
	onDraft,
	touched,
	onTouched,
	existing,
}: {
	draft: GcpConnectorDraft
	onDraft: (patch: Partial<GcpConnectorDraft>) => void
	touched: ScopeTouched
	onTouched: (touched: ScopeTouched) => void
	existing: ReadonlyArray<V2GcpConnector>
}) {
	const headingId = useId()
	const scope = SCOPES[draft.scopeType]
	const scopeName = GCP_SCOPE_NAMES[draft.scopeType].toLowerCase()
	const aggregated = draft.scopeType !== "project"
	const scopeId = draft.scopeId.trim()
	const hostProjectId = draft.hostProjectId.trim()
	// A rule turns red once its field was left, not while the first characters are being typed.
	const scopeIdInvalid =
		touched.scopeId &&
		scopeId.length > 0 &&
		!(aggregated ? isGcpResourceNumber(scopeId) : isGcpProjectId(scopeId))
	const hostInvalid =
		touched.hostProjectId && aggregated && hostProjectId.length > 0 && !isGcpProjectId(hostProjectId)
	const overlap = gcpOverlapNote(draft.scopeType, existing)

	return (
		<>
			<div className="flex flex-col gap-2">
				<h3 id={headingId} className={GCP_TITLE}>
					What should Maple watch?
				</h3>
				<ToggleGroup
					variant="outline"
					aria-labelledby={headingId}
					value={[draft.scopeType]}
					onValueChange={(values) => {
						const next = SCOPE_TYPES.find(
							(scopeType) => scopeType !== draft.scopeType && values.includes(scopeType),
						)
						if (next === undefined) return
						// The two kinds of ID never carry over, so the field starts over.
						onDraft({ scopeType: next, scopeId: "" })
						onTouched({ ...touched, scopeId: false })
					}}
					className="w-full"
				>
					{SCOPE_TYPES.map((scopeType) => (
						<ToggleGroupItem key={scopeType} value={scopeType} className="flex-1">
							{GCP_SCOPE_NAMES[scopeType]}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				<p className={SMALL}>{scope.description}</p>
			</div>
			<Field className="items-stretch gap-2" invalid={scopeIdInvalid}>
				<FieldLabel htmlFor="gcp-scope-id">{scope.idLabel}</FieldLabel>
				<FieldDescription className="leading-5 text-pretty">
					{scope.hint} To list them, run <GcpCommand>{scope.listCommand}</GcpCommand>
				</FieldDescription>
				<Input
					id="gcp-scope-id"
					autoComplete="off"
					spellCheck={false}
					placeholder={scope.placeholder}
					value={draft.scopeId}
					onChange={(event) => onDraft({ scopeId: event.target.value })}
					onBlur={() => onTouched({ ...touched, scopeId: true })}
					className="font-mono"
				/>
				{scopeIdInvalid ? (
					<FieldError match className="leading-5 text-pretty">
						{scope.idRule}
					</FieldError>
				) : null}
			</Field>
			{aggregated ? (
				<Field className="items-stretch gap-2" invalid={hostInvalid}>
					<FieldLabel htmlFor="gcp-host-project-id">Host project ID</FieldLabel>
					<FieldDescription className="leading-5 text-pretty">
						Holds Maple&apos;s Pub/Sub topic and read-only service account. A project inside the{" "}
						{scopeName} with billing enabled that won&apos;t be deleted.
					</FieldDescription>
					<Input
						id="gcp-host-project-id"
						autoComplete="off"
						spellCheck={false}
						placeholder="acme-observability"
						value={draft.hostProjectId}
						onChange={(event) => onDraft({ hostProjectId: event.target.value })}
						onBlur={() => onTouched({ ...touched, hostProjectId: true })}
						className="font-mono"
					/>
					{hostInvalid ? (
						<FieldError match className="leading-5 text-pretty">
							{PROJECT_ID_RULE}
						</FieldError>
					) : null}
				</Field>
			) : null}
			{overlap === null ? null : (
				<Alert size="sm" role="note">
					<CircleInfoIcon size={14} />
					<AlertDescription className="leading-5 text-pretty">{overlap}</AlertDescription>
				</Alert>
			)}
		</>
	)
}

interface ScopeTouched {
	readonly scopeId: boolean
	readonly hostProjectId: boolean
}

/**
 * A new connection's first two steps: the scope, then what to collect. Creating it leads into the
 * run step, where the script is.
 */
function NewConnection({
	title,
	metricsAvailable,
	existing,
	filter,
	onFilter,
	onCreated,
}: {
	title: React.ReactNode
	metricsAvailable: boolean
	existing: ReadonlyArray<V2GcpConnector>
	filter: FilterState
	onFilter: (filter: FilterState) => void
	onCreated: (connector: V2GcpConnector) => void
}) {
	const create = useAtomSet(MapleApiV2AtomClient.mutation("gcpIntegration", "createConnector"), {
		mode: "promiseExit",
	})
	const [step, setStep] = useState<"scope" | "data">("scope")
	const [draft, setDraft] = useState<GcpConnectorDraft>({
		scopeType: "project",
		scopeId: "",
		hostProjectId: "",
		logsEnabled: true,
		metricsEnabled: metricsAvailable,
	})
	const [error, setError] = useState<string | null>(null)
	const [touched, setTouched] = useState<ScopeTouched>({ scopeId: false, hostProjectId: false })
	const formId = useId()

	// Decoded with the API's own schema, so a rejected ID is caught before the request.
	const request = gcpCreateRequest(draft)
	const aggregated = draft.scopeType !== "project"
	const scopeId = draft.scopeId.trim()
	const scopeReady = aggregated
		? isGcpResourceNumber(scopeId) && isGcpProjectId(draft.hostProjectId.trim())
		: isGcpProjectId(scopeId)

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
		if (step === "scope") {
			if (scopeReady) setStep("data")
			return
		}
		if (!submitting) void submit()
	}

	return (
		<>
			<ConfigureHeader title={title} step={step === "scope" ? 0 : 1} />
			<DialogPanel>
				<form id={formId} onSubmit={handleSubmit} className="flex w-full flex-col gap-6 text-left">
					{step === "scope" ? (
						<ScopeFields
							draft={draft}
							onDraft={edit}
							touched={touched}
							onTouched={setTouched}
							existing={existing}
						/>
					) : (
						<CollectFields
							flags={{ logs_enabled: draft.logsEnabled, metrics_enabled: draft.metricsEnabled }}
							onChange={(flags) =>
								edit({
									logsEnabled: flags.logs_enabled,
									metricsEnabled: flags.metrics_enabled,
								})
							}
							metricsAvailable={metricsAvailable}
							logFilter={<LogFilter sinkExists={false} filter={filter} onFilter={onFilter} />}
						/>
					)}
					{error !== null ? (
						<p className="text-xs text-destructive-foreground" role="alert">
							{error}
						</p>
					) : null}
				</form>
			</DialogPanel>
			<DialogFooter>
				{step === "scope" ? (
					<DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
				) : (
					<Button variant="outline" disabled={submitting} onClick={() => setStep("scope")}>
						Back
					</Button>
				)}
				<Button
					type="submit"
					form={formId}
					disabled={step === "scope" ? !scopeReady : Option.isNone(request)}
					loading={submitting}
				>
					Continue
				</Button>
			</DialogFooter>
		</>
	)
}

/** A connection's data step: what it collects and its log filter. */
function ChooseStage({
	title,
	connector,
	metricsAvailable,
	filter,
	onFilter,
	onApply,
}: {
	title: React.ReactNode
	connector: V2GcpConnector
	metricsAvailable: boolean
	filter: FilterState
	onFilter: (filter: FilterState) => void
	/** Leads into the run step, with what was saved if anything changed. */
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
	const resuming = immediate.filter(({ acts }) => acts === "resumes-now")
	const named = (list: typeof immediate) =>
		list.map(({ capability }) => CAPABILITIES[capability].title.toLowerCase()).join(" and ")
	// One save can turn one capability off and the other back on: the question names both.
	const turned = [
		stopping.length > 0 ? `${named(stopping)} off` : null,
		resuming.length > 0 ? `${named(resuming)} back on` : null,
	]
		.filter((part) => part !== null)
		.join(" and ")
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
			<ConfigureHeader title={title} step={1} />
			<DialogPanel>
				<CollectFields
					flags={draft}
					onChange={setDraft}
					metricsAvailable={metricsAvailable}
					effect={effect}
					logFilter={
						<LogFilter
							sinkExists={sinkExists}
							filter={filter}
							onFilter={onFilter}
							logRouter={logRouterUrl(connector)}
						/>
					}
				/>
			</DialogPanel>
			<DialogFooter>
				{changed.length > 0 && !scripted ? (
					<FooterNote>Nothing to run after this: Google Cloud still has what it needs.</FooterNote>
				) : null}
				<DialogClose render={<Button variant="outline" disabled={saving} />}>Cancel</DialogClose>
				<Button
					loading={saving && !confirming}
					onClick={() =>
						changed.length === 0
							? onApply(null)
							: immediate.length > 0
								? setConfirming(true)
								: void save()
					}
				>
					{changed.length === 0 ? "Continue" : scripted ? "Save and continue" : "Save"}
				</Button>
			</DialogFooter>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				tone={stopping.length > 0 ? "destructive" : "default"}
				icon={stopping.length > 0 ? undefined : null}
				title={
					<>
						{`Turn ${turned}`} for {GCP_SCOPE_NAMES[connector.scope_type]}{" "}
						<span className="whitespace-nowrap">{connector.scope_id}</span>?
					</>
				}
				// Turning off leaves something for the script to remove; turning back on leaves nothing to run.
				confirmLabel={
					stopping.length === 0
						? "Turn on"
						: resuming.length === 0
							? "Turn off and continue"
							: "Save and continue"
				}
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
 * When a connection's run step was entered. `rerun`: nobody has said a run is under way, so
 * the step stays open until a newer run reports and its status does not time one.
 */
export interface ApplyOpened {
	readonly at: number
	readonly rerun: boolean
	/** The report on record at that moment: a different one is a newer run. */
	readonly seen: string | null
}

const Chip = ({ children }: { children: React.ReactNode }) => (
	<span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-xs/5">
		{children}
	</span>
)

/** What the script applies, so it is never a black box, and the way back to change it. */
function RunSummary({
	connector,
	logFilter,
	onEdit,
	byScript = true,
}: {
	connector: V2GcpConnector
	/** The log filter in a few words. */
	logFilter: string
	onEdit: () => void
	/** False when the Set up step is not the script, or not chosen yet. */
	byScript?: boolean
}) {
	const removed = byScript ? "removed by this run" : "to remove"
	const capabilities = [
		connector.logs_enabled
			? `Logs · ${logFilter}`
			: connector.applied_logs_enabled === true
				? `Logs · ${removed}`
				: null,
		connector.metrics_enabled
			? "Metrics"
			: connector.applied_metrics_enabled === true
				? `Metrics · ${removed}`
				: null,
	].filter((label) => label !== null)
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Chip>
				<span className="text-muted-foreground">{GCP_SCOPE_NAMES[connector.scope_type]}</span>
				<span className="font-mono">{connector.scope_id}</span>
			</Chip>
			{connector.scope_type === "project" ? null : (
				<Chip>
					<span className="text-muted-foreground">Host</span>
					<span className="font-mono">{connector.project_id}</span>
				</Chip>
			)}
			{capabilities.map((label) => (
				<Chip key={label}>{label}</Chip>
			))}
			<Button variant="link" size="xs" className="ml-auto h-auto p-0" onClick={onEdit}>
				Edit
			</Button>
		</div>
	)
}

/** Why a file couldn't be loaded, and the way to load it again. */
function LoadFailure({ failure }: { failure: ScriptFailure }) {
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
 * A generated file to copy: the start in view, the rest on request. With a `prompt`, copying it
 * shows the coding-agent prompt in the file's place. `children` come before the copy button.
 */
function FileCard({
	name,
	text,
	failure,
	secret,
	prompt,
	children,
}: {
	name: string
	text: string | null
	failure: ScriptFailure | null
	/** The setup script embeds the connection's secret; a setup as code carries none. */
	secret: boolean
	prompt?: string | null
	children?: React.ReactNode
}) {
	const [expanded, setExpanded] = useState(false)
	const [promptShown, setPromptShown] = useState(false)
	const { copy } = useCopy({ label: "prompt", toast: false })
	// Kept, unlike the copy status, which resets: the footer says whether this copy worked.
	const [copied, setCopied] = useState<boolean | null>(null)
	// Copy takes whatever is on screen.
	const copyable = promptShown ? (prompt ?? null) : text
	const shown = promptShown ? (prompt?.trimEnd() ?? null) : (text?.trimEnd() ?? null)
	const link = "h-auto p-0 font-normal text-xs text-muted-foreground hover:text-foreground"
	return (
		<div className="overflow-clip rounded-lg border">
			<div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
				<span className="font-mono text-xs text-muted-foreground">
					{promptShown ? "Prompt for a coding agent" : name}
					{shown === null || promptShown
						? null
						: ` · ${countLabel(shown.split("\n").length, "line")}`}
				</span>
				<span className="ml-auto flex flex-wrap items-center justify-end gap-2">
					{prompt === undefined ? null : (
						<Button
							size="sm"
							variant="outline"
							disabled={prompt === null}
							onClick={() => {
								setPromptShown(true)
								setCopied(null)
								void copy(prompt).then(setCopied)
							}}
						>
							{promptShown && copied === true ? <CheckIcon size={12} aria-hidden /> : null}
							{promptShown && copied === true
								? "Prompt copied"
								: "Copy prompt for coding agent"}
						</Button>
					)}
					<CopyButton
						value={copyable ?? ""}
						disabled={copyable === null}
						label={promptShown ? "prompt" : name}
						idleLabel={secret ? "Copy script" : "Copy"}
						toast={false}
						variant={children === undefined ? "default" : "outline"}
						size="sm"
						className={cn(
							children === undefined && "text-primary-foreground hover:text-primary-foreground",
						)}
					/>
					{children}
				</span>
			</div>
			{failure !== null ? (
				<div className="p-3">
					<LoadFailure failure={failure} />
				</div>
			) : shown === null ? (
				<div className="p-3">
					<Skeleton className="h-26 w-full" />
				</div>
			) : (
				<div className="relative">
					{/* The dashboard records itself with rrweb, which serializes plain text verbatim. */}
					<pre
						tabIndex={0}
						role="region"
						aria-label={promptShown ? "The prompt for a coding agent" : name}
						className={cn(
							"overflow-x-auto p-3 font-mono text-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
							// The prompt is prose; code keeps its lines.
							promptShown && "whitespace-pre-wrap",
							expanded ? "max-h-80 overflow-y-auto" : "max-h-32 overflow-y-hidden",
							secret && REPLAY_BLOCK_CLASS,
						)}
					>
						{shown}
					</pre>
					{expanded ? null : (
						<div
							aria-hidden
							className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-popover to-transparent"
						/>
					)}
				</div>
			)}
			<div className="flex items-center gap-3 border-t px-3 py-1.5 text-xs/5 text-muted-foreground">
				<span className="flex min-w-0 flex-1 items-center gap-1.5 text-pretty">
					<LockIcon size={12} className="shrink-0" aria-hidden />
					{promptShown
						? `${copied === false ? "Couldn't copy: select the prompt and copy it." : copied === true ? "Copied." : "Copying."} It ends with the full ${name}.`
						: secret
							? "Holds this connection's secret. Don't share or commit it."
							: "No secrets in this file. Safe to commit."}
				</span>
				{promptShown ? (
					<Button variant="link" size="xs" onClick={() => setPromptShown(false)} className={link}>
						Back to {name}
					</Button>
				) : null}
				{shown === null || failure !== null ? null : (
					<Button
						variant="link"
						size="xs"
						aria-expanded={expanded}
						onClick={() => setExpanded(!expanded)}
						className={link}
					>
						{expanded ? "Show less" : "Show all"}
					</Button>
				)}
			</div>
		</div>
	)
}

/** Who may run or apply a setup: an Owner of the host project, with the scope's roles. */
function RunAs({ connector }: { connector: V2GcpConnector }) {
	const scopeRoles = gcpScopeRoles(connector.scope_type, connector)
	const role = (name: string) => <span className="text-foreground">{name}</span>
	return (
		<>
			as an {role("Owner")} of {connector.scope_type === "project" ? null : "the host project "}
			<Mono>{connector.project_id}</Mono>
			{scopeRoles.map((name, index) => (
				<Fragment key={name}>
					{index === 0 ? " who also has " : " and "}
					{role(name)}
				</Fragment>
			))}
			{scopeRoles.length > 0 ? ` on the ${connector.scope_type}` : null}.
		</>
	)
}

type RunRowState = "pending" | "running" | "done"

function RunRowMarker({ state }: { state: RunRowState }) {
	return state === "done" ? (
		<CircleCheckIcon size={14} className="text-severity-info" aria-hidden />
	) : state === "running" ? (
		<Spinner className="size-3.5 text-muted-foreground" />
	) : (
		<span aria-hidden className="size-3.5 rounded-full border border-dashed border-muted-foreground/60" />
	)
}

/** How a setup without the script is confirmed: by the first data, as no run reports it. */
const CONFIRMED_BY = {
	logs: {
		done: "Confirmed: logs arrive",
		waiting: "Confirmed by the first log Maple receives",
	},
	metrics: {
		done: "Confirmed: metrics are read",
		waiting: "Confirmed by the first metrics read, within 5 minutes",
	},
} as const

/**
 * What Maple has heard, kept in view under the setup: a row per capability set up or removed,
 * ticked as the script reports or, without it, as the first data arrives. Past five minutes
 * without a script report, what to check.
 */
function RunStatus({
	connector,
	opened,
	overdue,
	nowMs,
	method,
}: {
	connector: V2GcpConnector
	opened: ApplyOpened
	overdue: boolean
	nowMs: number
	method: GcpSetupMethod
}) {
	const byScript = method === "script"
	// A row ticks on a report made since the step opened, not on what an earlier run left in place.
	const reported = connector.setup_reported_at !== opened.seen
	const running = gcpSetupRunning(connector, nowMs)
	const rows = CAPABILITY_IDS.flatMap((capability) => {
		const { title, flag, run } = CAPABILITIES[capability]
		const wanted = connector[flag]
		const applied =
			capability === "logs" ? connector.applied_logs_enabled : connector.applied_metrics_enabled
		if (!wanted && applied !== true) return []
		const confirmed = applied === wanted
		const state: RunRowState =
			confirmed && (reported || !byScript) ? "done" : running || !byScript ? "running" : "pending"
		// The poller's failure, once past the grant's grace: what a setup without the script can be told.
		const metricsState = gcpMetricsState(connector, nowMs)
		const error =
			!byScript && capability === "metrics" && metricsState.kind === "failing"
				? metricsState.error
				: null
		const detail = byScript
			? wanted
				? run.on
				: run.off
			: !wanted
				? "Waiting for you to confirm the removal"
				: (error ?? CONFIRMED_BY[capability][confirmed ? "done" : "waiting"])
		return [{ capability, title, detail, state, error }]
	})
	const done = rows.filter((row) => row.state === "done").length
	const reporting = done > 0 || running

	return (
		<div
			role="status"
			className={cn(
				"flex flex-col gap-3 border-t px-6 py-4",
				overdue && byScript && "bg-severity-warn/6",
			)}
		>
			<div className="flex items-center gap-2.5">
				{overdue && byScript ? (
					<AlertWarningIcon size={14} className="shrink-0 text-severity-warn" aria-hidden />
				) : done === rows.length ? (
					<CircleCheckIcon size={14} className="shrink-0 text-severity-info" aria-hidden />
				) : (
					<Spinner className="size-3.5 shrink-0 text-severity-debug" />
				)}
				<p className={cn("text-sm font-medium", overdue && byScript && "text-severity-warn")}>
					{!byScript
						? done === rows.length
							? "Confirmed by the first data"
							: "Waiting for Google Cloud"
						: overdue
							? "No report from the script yet"
							: reporting
								? "The script is reporting back"
								: "Waiting for the script to report back"}
				</p>
				<span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
					{reporting
						? `${done} of ${rows.length} ${byScript ? "done" : "confirmed"}`
						: "updates on its own"}
				</span>
			</div>
			{overdue && byScript ? (
				<div className="flex flex-col gap-2 pl-6 text-xs/5">
					<ul className="flex list-disc flex-col gap-1.5 pl-4 text-pretty text-muted-foreground">
						<li>
							<span className="font-medium text-foreground">Stopped with an error?</span> Fix
							what it names and paste it again. It continues where it stopped.
						</li>
						<li>
							<span className="font-medium text-foreground">Wrong ID?</span> Disconnect this
							connection and connect the right one. An ID can&apos;t be changed.
						</li>
					</ul>
					<p>
						<GcpExternalLink href={`${DOCS}#troubleshooting`}>Troubleshooting</GcpExternalLink>
					</p>
				</div>
			) : (
				<ul className="flex flex-col gap-1.5 pl-6">
					{rows.map((row) => (
						<li
							key={row.capability}
							className="grid grid-cols-[auto_10rem_1fr] items-center gap-x-2.5 text-xs/5"
						>
							<RunRowMarker state={row.state} />
							<span className="text-foreground">{row.title}</span>
							<span
								className={cn(
									"text-pretty",
									row.error === null ? "text-muted-foreground" : "text-severity-error",
								)}
							>
								{row.detail}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

/** The run confirmed: what each capability is doing now, live, so the first data is seen landing. */
function Applied({
	connector,
	created,
	nowMs,
}: {
	connector: V2GcpConnector
	created: boolean
	nowMs: number
}) {
	const log = gcpLogState(connector, nowMs)
	const metrics = gcpMetricsState(connector, nowMs)
	const rows = [
		log.kind === "off"
			? null
			: {
					title: "Logs",
					status: GCP_LOG_STATUS[log.kind],
					detail: log.kind === "waiting" ? "First entries within about 10 minutes" : null,
				},
		metrics.kind === "off"
			? null
			: {
					title: "Metrics",
					status: GCP_METRICS_STATUS[metrics.kind],
					detail: metrics.kind === "waiting" ? "First read within about 10 minutes" : null,
				},
	].filter((row) => row !== null)

	return (
		<div className="flex flex-col items-center gap-5 py-2 text-center">
			<span className="flex size-12 items-center justify-center rounded-full bg-severity-info/12 text-severity-info">
				<CheckIcon size={20} aria-hidden />
			</span>
			<div className="flex flex-col gap-1">
				<h3 className="text-base font-medium">
					{created ? (
						<>
							<span className="font-mono">{connector.scope_id}</span> is connected
						</>
					) : (
						"Google Cloud matches this configuration"
					)}
				</h3>
				<p className={SMALL}>The script finished. Data shows up in Maple on its own.</p>
			</div>
			<ul className="w-full divide-y divide-border/60 rounded-lg border text-left">
				{rows.map((row) => (
					<li key={row.title} className="flex items-center gap-3 px-4 py-2.5">
						<span className="w-16 shrink-0 text-sm font-medium">{row.title}</span>
						<span className="min-w-0 flex-1 text-xs/5 text-muted-foreground">{row.detail}</span>
						<span className="flex shrink-0 items-center gap-1.5 text-xs/5">
							<StatusDot tone={row.status.tone} />
							{row.status.label}
						</span>
					</li>
				))}
			</ul>
		</div>
	)
}

/** A run's sections report one after the other: confirmed once the last one has. */
const runConfirmed = (connector: V2GcpConnector, opened: ApplyOpened, nowMs: number) =>
	gcpScriptNeeded(connector, nowMs) === null &&
	!gcpSetupRunning(connector, nowMs) &&
	(!opened.rerun || connector.setup_reported_at !== opened.seen)

/** The run step: loads the script for the chosen filter and polls until Maple confirms the run. */
function ApplyStage({
	filter,
	...view
}: Omit<GcpApplyViewProps, "logFilter" | "script" | "failure"> & { filter: FilterState }) {
	const { connector, opened, nowMs } = view
	const choice = gcpLogFilterChoice(filter, connector.applied_logs_enabled === true)
	const { scripts, failure } = useGcpScripts(connector, choice.applicationLogs)
	const refresh = useAtomRefresh(gcpStatusQuery())
	useIntervalRefresh(refresh, {
		intervalMs: GCP_SETTLING_REFRESH_MS,
		enabled: !runConfirmed(connector, opened, nowMs),
	})
	return (
		<GcpApplyView
			{...view}
			logFilter={filterShort(choice)}
			script={scripts?.setup_script ?? null}
			failure={failure}
		/>
	)
}

export interface GcpApplyViewProps {
	title: React.ReactNode
	connector: V2GcpConnector
	/** Created in this surface: the confirmed run reads as the connection being made. */
	created: boolean
	/** The log filter in a few words. */
	logFilter: string
	script: string | null
	failure: ScriptFailure | null
	nowMs: number
	opened: ApplyOpened
	onBack: () => void
	onClose: () => void
}

/** The run step as it looks: the script and the run's status, or the confirmed run. Exported for the lab. */
export function GcpApplyView({
	title,
	connector,
	created,
	logFilter,
	script,
	failure,
	nowMs,
	opened,
	onBack,
	onClose,
}: GcpApplyViewProps) {
	const sinkExists = connector.applied_logs_enabled === true
	const reportedAt = connector.setup_reported_at
	const confirmed = runConfirmed(connector, opened, nowMs)
	const overdue = !opened.rerun && gcpScriptOverdue(connector, opened.at, nowMs)

	if (confirmed) {
		return (
			<>
				<ConfigureHeader title={title} />
				<DialogPanel>
					<Applied connector={connector} created={created} nowMs={nowMs} />
				</DialogPanel>
				<DialogFooter>
					{reportedAt === null ? null : (
						<FooterNote>
							<RelativeTime value={reportedAt} prefix="Setup finished" />
						</FooterNote>
					)}
					<Button onClick={onClose}>Done</Button>
				</DialogFooter>
			</>
		)
	}

	return (
		<>
			<ConfigureHeader title={title} step={3} />
			<DialogPanel className="flex flex-col gap-5">
				<RunSummary connector={connector} logFilter={logFilter} onEdit={onBack} />
				<section className="flex flex-col gap-3">
					<div className="flex flex-col gap-0.5">
						<h3 className={GCP_TITLE}>Run this script in Cloud Shell</h3>
						<p className={SMALL}>Nothing changes in Google Cloud until it runs.</p>
					</div>
					<FileCard name="setup.sh" text={script} failure={failure} secret>
						<GcpOpenCloudShellButton projectId={connector.project_id} variant="default" />
					</FileCard>
					<p className={SMALL}>
						Run it <RunAs connector={connector} />{" "}
						{!connector.logs_enabled && sinkExists
							? "Takes one to two minutes. "
							: "Takes about a minute and is safe to run again. "}
						<GcpExternalLink href={`${DOCS}#roles-for-running-the-script`}>
							Roles if you aren&apos;t an Owner
						</GcpExternalLink>
					</p>
				</section>
			</DialogPanel>
			<RunStatus
				connector={connector}
				opened={opened}
				overdue={overdue}
				nowMs={nowMs}
				method="script"
			/>
			<DialogFooter>
				<FooterNote>Saved. Close this any time and come back to it.</FooterNote>
				<Button variant="outline" onClick={onClose}>
					Close
				</Button>
			</DialogFooter>
		</>
	)
}

/** The Method step: how Google Cloud is set up. UI only: nothing is saved. Exported for the lab. */
export function GcpMethodStage({
	title,
	connector,
	logFilter,
	method,
	onMethod,
	onBack,
	onContinue,
}: {
	title: React.ReactNode
	connector: V2GcpConnector
	logFilter: string
	method: GcpSetupMethod
	onMethod: (method: GcpSetupMethod) => void
	onBack: () => void
	onContinue: () => void
}) {
	return (
		<>
			<ConfigureHeader title={title} step={2} />
			<DialogPanel className="flex flex-col gap-5">
				<RunSummary connector={connector} logFilter={logFilter} onEdit={onBack} byScript={false} />
				<GcpMethodChoice
					method={method}
					onMethod={onMethod}
					alchemyUnavailable={gcpAlchemyUnavailable(connector)}
				/>
			</DialogPanel>
			<DialogFooter>
				<FooterNote>Each method creates the same resources.</FooterNote>
				<Button variant="outline" onClick={onBack}>
					Back
				</Button>
				<Button onClick={onContinue}>Continue</Button>
			</DialogFooter>
		</>
	)
}

export interface GcpMethodApplyViewProps {
	title: React.ReactNode
	connector: V2GcpConnector
	method: Exclude<GcpSetupMethod, "script">
	/** The log filter in a few words. */
	logFilter: string
	/** The Data step kept the sink's filter, which a setup without the script can't: it sets the recommended one. */
	keepFilter: boolean
	setup: Pick<
		V2GcpSetupScripts,
		"push_endpoint" | "log_filter" | "maple_service_account_email" | "terraform" | "alchemy"
	> | null
	failure: ScriptFailure | null
	/** Records the removal of what was switched off, on the admin's word. */
	confirmRemoval: { readonly onConfirm: () => void; readonly confirming: boolean }
	nowMs: number
	opened: ApplyOpened
	onBack: () => void
	onClose: () => void
}

/**
 * The Set up step without the script: the console steps or the generated file, always, and what
 * Maple has confirmed. Exported for the lab.
 */
export function GcpMethodApplyView({
	title,
	connector,
	method,
	logFilter,
	keepFilter,
	setup,
	failure,
	confirmRemoval,
	nowMs,
	opened,
	onBack,
	onClose,
}: GcpMethodApplyViewProps) {
	const plan =
		setup === null
			? null
			: gcpSetupPlan({
					connectorId: connector.id,
					scopeType: connector.scope_type,
					scopeId: connector.scope_id,
					projectId: connector.project_id,
					pushEndpoint: setup.push_endpoint,
					mapleServiceAccountEmail: setup.maple_service_account_email ?? undefined,
					logsEnabled: connector.logs_enabled,
					metricsEnabled: connector.metrics_enabled,
					logFilter: setup.log_filter,
				})
	const removal = gcpRemovalList(connector)
	const flavour = method === "alchemy" ? "alchemy" : "terraform"
	const iac = method === "manual" ? null : method === "terraform" ? "tf" : "ts"
	const config = setup === null ? null : method === "alchemy" ? setup.alchemy : setup.terraform
	// A file removes only what it created: what a script or the console made is deleted by hand.
	const removalSection =
		removal.length === 0 ? null : (
			<section className="flex flex-col gap-3">
				<div className="flex flex-col gap-0.5">
					<h3 className={GCP_TITLE}>
						{iac === null
							? "Delete these in the Google Cloud console"
							: "If your file didn't create these, delete them in the console"}
					</h3>
					<p className={SMALL}>
						In this order: Google keeps routing to the topic for a while.{" "}
						<GcpExternalLink href={`${MANUAL_DOCS}#removing`}>Details</GcpExternalLink>
					</p>
				</div>
				<ol className="flex list-decimal flex-col gap-2 pl-5 text-xs/5">
					{removal.map((item) => (
						<li key={item.what}>
							<span className="text-muted-foreground">{item.what}</span>{" "}
							<GcpValue value={item.name} />
						</li>
					))}
				</ol>
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<p className={SMALL}>Maple can&apos;t see a removal. Tell it once it is done.</p>
					<Button
						size="sm"
						variant="outline"
						loading={confirmRemoval.confirming}
						onClick={confirmRemoval.onConfirm}
					>
						I&apos;ve removed them
					</Button>
				</div>
			</section>
		)
	return (
		<>
			<ConfigureHeader title={title} step={3} />
			<DialogPanel className="flex flex-col gap-5">
				<RunSummary connector={connector} logFilter={logFilter} onEdit={onBack} byScript={false} />
				{keepFilter && connector.logs_enabled ? (
					<p className={SMALL}>
						Sets the recommended filter. If you customised the sink&apos;s filter, paste yours
						instead.
					</p>
				) : null}
				{iac === null ? (
					<>
						{removalSection}
						{failure !== null ? (
							<LoadFailure failure={failure} />
						) : plan === null ? (
							<Skeleton className="h-60 w-full" />
						) : plan.logs === null && plan.reader === null ? null : (
							<GcpManualSteps
								heading="Create these in the Google Cloud console"
								detail={
									connector.scope_type === "project"
										? `In ${connector.project_id}. Names are generated for this connection.`
										: `Resources go in ${connector.project_id}; the sink and read-only roles on the ${connector.scope_type}.`
								}
								steps={gcpManualSteps(plan)}
								docsHref={MANUAL_DOCS}
							/>
						)}
					</>
				) : (
					<section className="flex flex-col gap-3">
						<div className="flex flex-col gap-0.5">
							<h3 className={GCP_TITLE}>
								{method === "terraform"
									? "Add this to your Terraform configuration"
									: "Add this to your Alchemy app"}
							</h3>
							<p className={SMALL}>
								{removal.length === 0
									? `Same resources as the script. Nothing changes in Google Cloud until you ${method === "terraform" ? "apply" : "deploy"}.`
									: `Replace your earlier maple.${iac} with this version: applying it removes what that one created and this one no longer has.`}
							</p>
						</div>
						<FileCard
							name={`maple.${iac}`}
							text={config}
							failure={failure}
							secret={false}
							prompt={
								plan === null || config === null
									? null
									: gcpAgentPrompt({ flavour, config, plan, connector })
							}
						/>
						<p className={SMALL}>
							{method === "terraform" ? (
								<>
									Apply with <Mono>terraform apply</Mono> <RunAs connector={connector} />
								</>
							) : (
								<>
									Deploy with the command in the file&apos;s header{" "}
									<RunAs connector={connector} />
									{connector.logs_enabled
										? " Fill in PROJECT_NUMBER at the top first."
										: null}
								</>
							)}{" "}
							<GcpExternalLink href={IAC_DOCS}>Details</GcpExternalLink>
						</p>
						{removalSection}
					</section>
				)}
			</DialogPanel>
			<RunStatus connector={connector} opened={opened} overdue={false} nowMs={nowMs} method={method} />
			<DialogFooter>
				<FooterNote>Saved. Close this any time and come back to it.</FooterNote>
				<Button variant="outline" onClick={onClose}>
					Close
				</Button>
			</DialogFooter>
		</>
	)
}

/** The Set up step without the script: loads the setup, polls for the first data, records removals. */
function MethodApplyStage({
	filter,
	...view
}: Omit<GcpMethodApplyViewProps, "logFilter" | "keepFilter" | "setup" | "failure" | "confirmRemoval"> & {
	filter: FilterState
}) {
	const { connector } = view
	const choice = gcpLogFilterChoice(filter, connector.applied_logs_enabled === true)
	const { scripts, failure } = useGcpScripts(connector, choice.applicationLogs)
	const confirm = useAtomSet(MapleApiV2AtomClient.mutation("gcpIntegration", "confirmRemoval"), {
		mode: "promiseExit",
	})
	const [confirmRemoval, confirming] = useAsyncAction(async () => {
		const result = await confirm({ params: { id: connector.id }, reactivityKeys: GCP_REACTIVITY_KEYS })
		if (Exit.isFailure(result)) showErrorToast(result, { title: "Couldn't record the removal" })
	})
	const refresh = useAtomRefresh(gcpStatusQuery())
	useIntervalRefresh(refresh, {
		intervalMs: GCP_SETTLING_REFRESH_MS,
		// Until each capability's first data, or its removal, is confirmed.
		enabled: CAPABILITY_IDS.some((capability) => {
			const applied =
				capability === "logs" ? connector.applied_logs_enabled : connector.applied_metrics_enabled
			return connector[CAPABILITIES[capability].flag] ? applied !== true : applied === true
		}),
	})
	return (
		<GcpMethodApplyView
			{...view}
			// Without the script there is no filter to keep.
			logFilter={choice.keep ? "Recommended filter, replaces the current one" : filterShort(choice)}
			keepFilter={choice.keep}
			setup={scripts}
			failure={failure}
			confirmRemoval={{ onConfirm: () => void confirmRemoval(), confirming }}
		/>
	)
}

/** The dialog every step renders in. */
export function GcpConfigureFrame({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
	return (
		<Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogContent className="font-display sm:max-w-2xl">{children}</DialogContent>
		</Dialog>
	)
}

/** What the configuration surface is open on. */
export type GcpConfigureTarget =
	| { readonly kind: "new" }
	| { readonly kind: "connection"; readonly id: string; readonly stage: "choose" | "apply" }

/** A connection's two steps. Admin-only: fetching the script is refused for everyone else. */
function ConnectionStages({
	title,
	connector: saved,
	created,
	initialStage,
	metricsAvailable,
	filter,
	onFilter,
	nowMs,
	onClose,
}: {
	title: React.ReactNode
	connector: V2GcpConnector
	/** Created in this surface a moment ago: the script has not run and a run is expected. */
	created: boolean
	initialStage: "choose" | "apply"
	metricsAvailable: boolean
	filter: FilterState
	onFilter: (filter: FilterState) => void
	nowMs: number
	onClose: () => void
}) {
	// What was just saved, shown until the status read delivers a newer connector. Without it the
	// run step would read the old configuration for the length of the refetch.
	const [asked, setAsked] = useState<{ readonly of: V2GcpConnector; readonly flags: GcpFlags } | null>(null)
	const connector = asked !== null && asked.of === saved ? { ...saved, ...asked.flags } : saved
	const open = (rerun: boolean): ApplyOpened => ({
		at: Date.now(),
		rerun,
		seen: saved.setup_reported_at,
	})
	// How Google Cloud is set up: asked before every Set up step, kept while the dialog is open.
	const [picked, setMethod] = useState<GcpSetupMethod>("script")
	// Alchemy can't grant roles on a folder or organization: switching metrics on there since it was
	// picked leaves Terraform.
	const method = picked === "alchemy" && gcpAlchemyUnavailable(connector) !== null ? "terraform" : picked
	// Whether a run was asked for when the Method step was left: found waiting on a first run, the
	// status times it from the connection's creation; found any other way, nobody has said one is under way.
	const [rerun, setRerun] = useState<boolean | null>(() =>
		initialStage === "apply" ? !created && gcpScriptNeeded(saved, Date.now()) !== "setup-pending" : null,
	)
	const [stage, setStage] = useState<"choose" | "method">(initialStage === "apply" ? "method" : "choose")
	const [opened, setOpened] = useState<ApplyOpened | null>(null)
	const choice = gcpLogFilterChoice(filter, connector.applied_logs_enabled === true)

	if (opened !== null) {
		const back = () => {
			setOpened(null)
			setStage("method")
		}
		return method === "script" ? (
			<ApplyStage
				title={title}
				connector={connector}
				created={created}
				filter={filter}
				nowMs={nowMs}
				opened={opened}
				onBack={back}
				onClose={onClose}
			/>
		) : (
			<MethodApplyStage
				title={title}
				connector={connector}
				method={method}
				filter={filter}
				nowMs={nowMs}
				opened={opened}
				onBack={back}
				onClose={onClose}
			/>
		)
	}
	return stage === "choose" ? (
		<ChooseStage
			title={title}
			connector={connector}
			metricsAvailable={metricsAvailable}
			filter={filter}
			onFilter={onFilter}
			onApply={(flags) => {
				if (flags !== null) setAsked({ of: saved, flags })
				setRerun(flags === null)
				setStage("method")
			}}
		/>
	) : (
		<GcpMethodStage
			title={title}
			connector={connector}
			logFilter={filterShort(choice)}
			method={method}
			onMethod={setMethod}
			onBack={() => setStage("choose")}
			onContinue={() => setOpened(open(rerun ?? true))}
		/>
	)
}

/**
 * The one place a connection is configured, as three steps: the scope, what to collect with its log
 * filter, then the script that applies it in Google Cloud. A connection reopens on the last two.
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
	const [filter, setFilter] = useState<FilterState>({ keep: null, runtimes: null })
	// The connector the surface created, until the status read lists it.
	const [created, setCreated] = useState<V2GcpConnector | null>(null)
	const connector =
		target.kind === "new"
			? undefined
			: (connectors.find((candidate) => candidate.id === target.id) ??
				(created?.id === target.id ? created : undefined))
	const createdHere = connector !== undefined && created?.id === connector.id
	// A connection made here keeps the flow's name to its end.
	const [newTitle] = useState(connectors.length === 0 ? "Connect Google Cloud" : "Add connection")
	const title =
		connector === undefined || createdHere ? (
			newTitle
		) : (
			<>
				{GCP_SCOPE_NAMES[connector.scope_type]}{" "}
				<span className="font-mono whitespace-nowrap">{connector.scope_id}</span>
			</>
		)

	return (
		<GcpConfigureFrame onClose={onClose}>
			{/* Each step brings its own header, panel and footer. */}
			{target.kind !== "new" && connector === undefined ? (
				<>
					<ConfigureHeader title="Google Cloud" step={1} />
					<DialogPanel>
						<Skeleton className="h-40 w-full" />
					</DialogPanel>
				</>
			) : connector === undefined ? (
				<NewConnection
					title={title}
					metricsAvailable={metricsAvailable}
					existing={connectors}
					filter={filter}
					onFilter={setFilter}
					onCreated={(connector) => {
						setCreated(connector)
						onCreated(connector)
					}}
				/>
			) : (
				<ConnectionStages
					key={connector.id}
					title={title}
					connector={connector}
					created={createdHere}
					initialStage={target.kind === "connection" ? target.stage : "apply"}
					metricsAvailable={metricsAvailable}
					filter={filter}
					onFilter={setFilter}
					nowMs={nowMs}
					onClose={onClose}
				/>
			)}
		</GcpConfigureFrame>
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
	const { scripts, failure } = useGcpScripts(connector, undefined)
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
									<>
										{`Run the cleanup script in Cloud Shell. Takes ${connector.applied_logs_enabled === true ? "one to two minutes" : "about a minute"}. `}
										Set up with Terraform or in the console? Remove them there (
										<a href={`${IAC_DOCS}#change-or-remove`} target="_blank" rel="noreferrer" className="underline">
											Terraform
										</a>
										,{" "}
										<a href={`${MANUAL_DOCS}#removing`} target="_blank" rel="noreferrer" className="underline">
											console
										</a>
										), then disconnect.
									</>
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
							{connector.applied_logs_enabled === false
								? "Disconnecting before the cleanup leaves the read-only service account in Google Cloud."
								: "Disconnecting before the cleanup leaves Google Cloud publishing logs to Pub/Sub, billed by Google."}
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
