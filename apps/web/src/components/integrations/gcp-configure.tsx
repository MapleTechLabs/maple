import { Fragment, useId, useState } from "react"
import type React from "react"
import { Exit, Option } from "effect"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import type { GcpLogFilter, GcpScopeType } from "@maple/domain/primitives"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
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
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Input } from "@maple/ui/components/ui/input"
import { Radio, RadioGroup } from "@maple/ui/components/ui/radio-group"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Switch } from "@maple/ui/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
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
	GCP_SCOPE_NAMES,
	cloudShellUrl,
	gcpCollectLock,
	gcpCreateRequest,
	gcpDraftEffect,
	gcpLogFilterChoice,
	gcpLogFilters,
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
} from "./gcp-connector-state"
import { gcpStatusQuery } from "./integration-catalog"

export const GCP_REACTIVITY_KEYS = ["gcpIntegration"]
/** Invalidated by a saved configuration: the script depends on what the connector collects. */
const SCRIPT_REACTIVITY_KEYS = ["gcpSetupScripts"]

/** Fast enough to see a script run confirmed, the first data land, or an error clear. */
export const GCP_SETTLING_REFRESH_MS = 10_000

const DOCS = docsUrl("gcp")
const OTEL_DOCS = docsUrl("gcpOpenTelemetry")

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
			"Cloud Run, GKE, Compute Engine, Cloud SQL, Pub/Sub, Load Balancing and Cloud Functions. Read-only, every 5 minutes.",
		run: { on: "Read-only service account", off: "Removes the service account" },
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
		/** What the script sets up for it, or removes, in the run step's status. */
		readonly run: { readonly on: string; readonly off: string }
		readonly effects: { readonly [Effect in GcpDraftEffect]: string }
		/** What a choice that acts at once does when it is saved, and what stays until the script runs. */
		readonly now: { readonly [Effect in "stops-now" | "resumes-now"]: string }
		readonly later: { readonly [Effect in "stops-now" | "resumes-now"]: string }
	}
}
const CAPABILITY_IDS: ReadonlyArray<GcpCapability> = ["logs", "metrics"]

/** The log filters' names, short in the closed disclosure and the run summary, and what each does. */
const FILTER_TEXT = {
	default: {
		short: "Recommended",
		title: "Recommended",
		description:
			"Request, audit and managed-service logs. Leaves out GKE container logs and health-check noise.",
	},
	include_gke_container_logs: {
		short: "With GKE container logs",
		title: "Include GKE container logs",
		description: "Everything Recommended forwards, plus GKE container logs.",
	},
	keep: {
		short: "Current filter",
		title: "Keep the current filter",
		description: "The filter the log sink has now. Maple doesn't store it.",
	},
} as const satisfies {
	readonly [Filter in GcpLogFilter]: {
		readonly short: string
		readonly title: string
		readonly description: string
	}
}

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

export interface ScriptFailure {
	readonly message: string
	readonly retry: () => void
	readonly retrying: boolean
}

/** The log filter the script is asked for, and whether including GKE container logs was confirmed. */
interface FilterState {
	readonly chosen: GcpLogFilter | null
	readonly acknowledged: boolean
}

const STEPS = ["Scope", "Data", "Run setup"] as const
/** The step the flow is on. */
type StepIndex = 0 | 1 | 2

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

/**
 * The filter the script gives the log sink, closed on its current choice. Including GKE container
 * logs asks to be confirmed, and stays open until it is.
 */
function LogFilter({
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
	const [open, setOpen] = useState(false)
	const filters = gcpLogFilters(sinkExists)
	const choice = gcpLogFilterChoice(filter.chosen, filter.acknowledged, sinkExists)
	return (
		<Collapsible
			open={open || choice.unacknowledged}
			onOpenChange={setOpen}
			className="rounded-md border border-border/60 bg-muted/32"
		>
			<CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
				<span className="text-foreground">Log filter</span>
				<span className="truncate text-muted-foreground">{FILTER_TEXT[choice.selected].short}</span>
				<ChevronDownIcon
					size={12}
					className="ml-auto shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
					aria-hidden
				/>
			</CollapsibleTrigger>
			<CollapsiblePanel className="flex flex-col gap-3 border-t border-border/60 p-3">
				<RadioGroup
					aria-label="Log filter"
					value={choice.selected}
					onValueChange={(value) => {
						const next = filters.find((option) => option.value === value)
						if (next !== undefined) onFilter({ chosen: next.value, acknowledged: false })
					}}
				>
					{filters.map(({ value }) => (
						<label key={value} className="flex items-start gap-2.5">
							<Radio value={value} className="mt-0.5" />
							<span className="flex flex-col">
								<span className="text-xs/5 text-foreground">{FILTER_TEXT[value].title}</span>
								<span className={SMALL}>
									{FILTER_TEXT[value].description}
									{value === "keep" && logRouter !== undefined ? (
										<>
											{" "}
											<GcpExternalLink href={logRouter}>Log Router</GcpExternalLink>
										</>
									) : null}
								</span>
							</span>
						</label>
					))}
				</RadioGroup>
				{choice.selected !== "include_gke_container_logs" ? null : (
					<div
						role="group"
						aria-label="GKE container logs"
						className="flex flex-col gap-2 rounded-md border border-severity-warn/32 bg-severity-warn/6 p-3 text-xs/5"
					>
						<p className="flex items-start gap-2 text-pretty text-foreground">
							<AlertWarningIcon
								size={12}
								className="mt-1 shrink-0 text-severity-warn"
								aria-hidden
							/>
							<span>
								Workloads instrumented with OpenTelemetry already send these logs to Maple,
								linked to their traces. Including them stores each line twice.{" "}
								<GcpExternalLink href={OTEL_DOCS}>
									Google Cloud with OpenTelemetry
								</GcpExternalLink>
							</span>
						</p>
						<label htmlFor={checkboxId} className="flex items-center gap-2 pl-5 text-foreground">
							<Checkbox
								id={checkboxId}
								checked={filter.acknowledged}
								onCheckedChange={(checked) =>
									onFilter({ ...filter, acknowledged: checked === true })
								}
							/>
							I understand these logs can be stored twice
						</label>
					</div>
				)}
				<p className={SMALL}>
					{sinkExists && choice.selected !== "keep"
						? "Replaces the sink's current filter when the script runs. "
						: null}
					<GcpExternalLink href={`${DOCS}#log-filter`}>Write your own filter</GcpExternalLink>
				</p>
			</CollapsiblePanel>
		</Collapsible>
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
		if (step === "scope") {
			if (scopeReady) setStep("data")
			return
		}
		if (!submitting && !unacknowledged) void submit()
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
				{step === "data" && unacknowledged ? (
					<FooterNote>Confirm the warning to continue.</FooterNote>
				) : null}
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
					disabled={step === "scope" ? !scopeReady : Option.isNone(request) || unacknowledged}
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
				{unacknowledged ? (
					<FooterNote>Confirm the warning to continue.</FooterNote>
				) : changed.length > 0 && !scripted ? (
					<FooterNote>Nothing to run after this: Google Cloud still has what it needs.</FooterNote>
				) : null}
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
}: {
	connector: V2GcpConnector
	logFilter: GcpLogFilter
	onEdit: () => void
}) {
	const capabilities = [
		connector.logs_enabled
			? `Logs · ${FILTER_TEXT[logFilter].short}`
			: connector.applied_logs_enabled === true
				? "Logs · removed by this run"
				: null,
		connector.metrics_enabled
			? "Metrics"
			: connector.applied_metrics_enabled === true
				? "Metrics · removed by this run"
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

/**
 * The setup script: copied, or run straight from Cloud Shell. Both scripts are a few hundred lines,
 * so the card shows the start and opens the rest on request.
 */
function ScriptCard({
	script,
	failure,
	projectId,
}: {
	script: string | null
	failure: ScriptFailure | null
	projectId: string
}) {
	const [expanded, setExpanded] = useState(false)
	const text = script?.trimEnd() ?? null
	return (
		<div className="overflow-clip rounded-lg border">
			<div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
				<span className="font-mono text-xs text-muted-foreground">
					setup.sh{text === null ? null : ` · ${countLabel(text.split("\n").length, "line")}`}
				</span>
				<span className="ml-auto flex items-center gap-2">
					<CopyButton
						value={script ?? ""}
						disabled={script === null}
						label="script"
						idleLabel="Copy script"
						toast={false}
						variant="outline"
						size="sm"
					/>
					<GcpOpenCloudShellButton projectId={projectId} variant="default" />
				</span>
			</div>
			{failure !== null ? (
				<div className="flex flex-wrap items-center gap-2 p-3">
					<p className="text-xs text-severity-error" role="alert">
						{failure.message}
					</p>
					<Button size="sm" variant="outline" onClick={failure.retry} loading={failure.retrying}>
						Try again
					</Button>
				</div>
			) : text === null ? (
				<div className="p-3">
					<Skeleton className="h-26 w-full" />
				</div>
			) : (
				<div className="relative">
					{/* The dashboard records itself with rrweb, which serializes plain text verbatim. */}
					<pre
						tabIndex={0}
						role="region"
						aria-label="The setup script"
						className={cn(
							"p-3 font-mono text-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
							expanded
								? "max-h-80 overflow-auto"
								: "max-h-32 overflow-x-auto overflow-y-hidden",
							REPLAY_BLOCK_CLASS,
						)}
					>
						{text}
					</pre>
					{expanded ? null : (
						<div
							aria-hidden
							className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-popover to-transparent"
						/>
					)}
				</div>
			)}
			<div className="flex items-center gap-1.5 border-t px-3 py-1.5 text-xs/5 text-muted-foreground">
				<LockIcon size={12} className="shrink-0" aria-hidden />
				<span className="min-w-0 flex-1 text-pretty">
					Holds this connection&apos;s secret. Don&apos;t share or commit it.
				</span>
				{text === null || failure !== null ? null : (
					<Button
						variant="link"
						size="xs"
						aria-expanded={expanded}
						onClick={() => setExpanded(!expanded)}
						className="h-auto p-0 font-normal text-xs text-muted-foreground hover:text-foreground"
					>
						{expanded ? "Show less" : "Show all"}
					</Button>
				)}
			</div>
		</div>
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

/**
 * What Maple has heard from the script, kept in view under the script: a row per capability the
 * run sets up or removes, ticked as its section reports. Past five minutes, what to check.
 */
function RunStatus({
	connector,
	opened,
	overdue,
	nowMs,
}: {
	connector: V2GcpConnector
	opened: ApplyOpened
	overdue: boolean
	nowMs: number
}) {
	// A row ticks on a report made since the step opened, not on what an earlier run left in place.
	const reported = connector.setup_reported_at !== opened.seen
	const running = gcpSetupRunning(connector, nowMs)
	const rows = CAPABILITY_IDS.flatMap((capability) => {
		const { title, flag, run } = CAPABILITIES[capability]
		const wanted = connector[flag]
		const applied =
			capability === "logs" ? connector.applied_logs_enabled : connector.applied_metrics_enabled
		if (!wanted && applied !== true) return []
		const state: RunRowState = applied === wanted && reported ? "done" : running ? "running" : "pending"
		return [{ capability, title, detail: wanted ? run.on : run.off, state }]
	})
	const done = rows.filter((row) => row.state === "done").length
	const reporting = done > 0 || running

	return (
		<div
			role="status"
			className={cn("flex flex-col gap-3 border-t px-6 py-4", overdue && "bg-severity-warn/6")}
		>
			<div className="flex items-center gap-2.5">
				{overdue ? (
					<AlertWarningIcon size={14} className="shrink-0 text-severity-warn" aria-hidden />
				) : (
					<Spinner className="size-3.5 shrink-0 text-severity-debug" />
				)}
				<p className={cn("text-sm font-medium", overdue && "text-severity-warn")}>
					{overdue
						? "No report from the script yet"
						: reporting
							? "The script is reporting back"
							: "Waiting for the script to report back"}
				</p>
				<span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
					{reporting ? `${done} of ${rows.length} done` : "updates on its own"}
				</span>
			</div>
			{overdue ? (
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
							<span className="text-muted-foreground">{row.detail}</span>
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
	const choice = gcpLogFilterChoice(
		filter.chosen,
		filter.acknowledged,
		connector.applied_logs_enabled === true,
	)
	const { scripts, failure } = useGcpScripts(connector, choice.scriptFilter)
	const refresh = useAtomRefresh(gcpStatusQuery())
	useIntervalRefresh(refresh, {
		intervalMs: GCP_SETTLING_REFRESH_MS,
		enabled: !runConfirmed(connector, opened, nowMs),
	})
	return (
		<GcpApplyView
			{...view}
			logFilter={choice.scriptFilter}
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
	logFilter: GcpLogFilter
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

	const scopeRoles = gcpScopeRoles(connector.scope_type, connector)
	const scopeName = GCP_SCOPE_NAMES[connector.scope_type].toLowerCase()
	const role = (name: string) => <span className="text-foreground">{name}</span>

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
			<ConfigureHeader title={title} step={2} />
			<DialogPanel className="flex flex-col gap-5">
				<RunSummary connector={connector} logFilter={logFilter} onEdit={onBack} />
				<section className="flex flex-col gap-3">
					<div className="flex flex-col gap-0.5">
						<h3 className={GCP_TITLE}>Run this script in Cloud Shell</h3>
						<p className={SMALL}>Nothing changes in Google Cloud until it runs.</p>
					</div>
					<ScriptCard script={script} failure={failure} projectId={connector.project_id} />
					<p className={SMALL}>
						Run it as an {role("Owner")} of{" "}
						{connector.scope_type === "project" ? null : "the host project "}
						<Mono>{connector.project_id}</Mono>
						{scopeRoles.map((name, index) => (
							<Fragment key={name}>
								{index === 0 ? " who also has " : " and "}
								{role(name)}
							</Fragment>
						))}
						{scopeRoles.length > 0 ? ` on the ${scopeName}` : null}.{" "}
						{!connector.logs_enabled && sinkExists
							? "Takes one to two minutes. "
							: "Takes about a minute and is safe to run again. "}
						<GcpExternalLink href={`${DOCS}#roles-for-running-the-script`}>
							Roles if you aren&apos;t an Owner
						</GcpExternalLink>
					</p>
				</section>
			</DialogPanel>
			<RunStatus connector={connector} opened={opened} overdue={overdue} nowMs={nowMs} />
			<DialogFooter>
				<FooterNote>Saved. Close this any time and come back to it.</FooterNote>
				<Button variant="outline" onClick={onClose}>
					Close
				</Button>
			</DialogFooter>
		</>
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
	// Found waiting on a first run, the status times it from the connection's creation. Found
	// any other way, nobody has said a run is under way.
	const [opened, setOpened] = useState<ApplyOpened | null>(() =>
		initialStage === "apply"
			? open(!created && gcpScriptNeeded(saved, Date.now()) !== "setup-pending")
			: null,
	)

	return opened === null ? (
		<ChooseStage
			title={title}
			connector={connector}
			metricsAvailable={metricsAvailable}
			filter={filter}
			onFilter={onFilter}
			onApply={(flags) => {
				if (flags !== null) setAsked({ of: saved, flags })
				setOpened(open(flags === null))
			}}
		/>
	) : (
		<ApplyStage
			title={title}
			connector={connector}
			created={created}
			filter={filter}
			nowMs={nowMs}
			opened={opened}
			onBack={() => setOpened(null)}
			onClose={onClose}
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
	const [filter, setFilter] = useState<FilterState>({ chosen: null, acknowledged: false })
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
