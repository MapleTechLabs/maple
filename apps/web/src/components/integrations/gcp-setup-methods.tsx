import { useId, useState } from "react"
import type React from "react"
import type { V2GcpSetupStep } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { Radio, RadioGroup } from "@maple/ui/components/ui/radio-group"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { useCopy } from "@maple/ui/hooks/use-copy"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { CheckIcon, ChevronDownIcon, CircleCheckIcon, ExternalLinkIcon, LockIcon } from "@/components/icons"

import { GCP_SMALL, GCP_TITLE, GcpExternalLink } from "./gcp-primitives"
import type { GcpManualStep, GcpSetupCheck, GcpSetupMethod, GcpStepField } from "./gcp-setup-steps"

const METHODS = [
	{
		value: "script",
		title: "Cloud Shell script",
		badge: "Recommended",
		description: "Runs a gcloud script in Cloud Shell. You can read it before it runs. About a minute.",
	},
	{
		value: "manual",
		title: "Manual setup",
		badge: null,
		description: "Create each resource yourself in the Google Cloud console. About 15 minutes.",
	},
	{
		value: "code",
		title: "Infrastructure as code",
		badge: null,
		description: "Generate Terraform or Alchemy config to review and apply from your own repo.",
	},
] as const

const FLAVOURS = {
	terraform: { label: "Terraform", hint: "maple.tf for the google provider" },
	alchemy: { label: "Alchemy", hint: "maple.ts for alchemy/GCP" },
} as const

/** The Method step's choice: one row per way to connect, the code flavour under its row. */
export function GcpMethodChoice({
	method,
	onMethod,
	alchemyUnavailable,
}: {
	method: GcpSetupMethod
	onMethod: (method: GcpSetupMethod) => void
	/** Why Alchemy can't express this connection, or null. */
	alchemyUnavailable: string | null
}) {
	const id = useId()
	const row = method === "terraform" || method === "alchemy" ? "code" : method
	const flavour = method === "alchemy" ? "alchemy" : "terraform"
	return (
		<fieldset className="flex flex-col gap-3">
			<legend className={cn(GCP_TITLE, "mb-3")}>How do you want to connect?</legend>
			<RadioGroup
				value={row}
				onValueChange={(value) => onMethod(value === "code" ? flavour : (value as GcpSetupMethod))}
				className="gap-0 divide-y divide-border/60 rounded-lg border"
			>
				{METHODS.map((option) => (
					<div key={option.value} className="flex flex-col gap-3 p-4">
						<div className="flex items-start gap-3">
							<Radio id={`${id}-${option.value}`} value={option.value} className="mt-0.5" />
							<label
								htmlFor={`${id}-${option.value}`}
								className="flex min-w-0 cursor-pointer flex-col gap-0.5"
							>
								<span className="flex items-baseline gap-2 text-sm font-medium">
									{option.title}
									{option.badge === null ? null : (
										<span className="text-xs font-normal text-muted-foreground">
											{option.badge}
										</span>
									)}
								</span>
								<span className={GCP_SMALL}>{option.description}</span>
							</label>
						</div>
						{option.value === "code" && row === "code" ? (
							<div className="flex flex-col gap-1.5 pl-7">
								<div className="flex flex-wrap items-center gap-3">
									<ToggleGroup
										variant="outline"
										size="sm"
										value={[flavour]}
										onValueChange={(values) => {
											const next = (["terraform", "alchemy"] as const).find(
												(value) => value !== flavour && values.includes(value),
											)
											if (next !== undefined) onMethod(next)
										}}
									>
										<ToggleGroupItem value="terraform">Terraform</ToggleGroupItem>
										<ToggleGroupItem
											value="alchemy"
											disabled={alchemyUnavailable !== null}
										>
											Alchemy
										</ToggleGroupItem>
									</ToggleGroup>
									<span className={GCP_SMALL}>{FLAVOURS[flavour].hint}</span>
								</div>
								{alchemyUnavailable === null ? null : (
									<p className={GCP_SMALL}>{alchemyUnavailable}</p>
								)}
							</div>
						) : null}
					</div>
				))}
			</RadioGroup>
		</fieldset>
	)
}

/** One value of a step: an exact name in mono with its copy button, or a setting in words. */
function StepValue({ value, copy }: { value: GcpStepField["value"]; copy: boolean }) {
	if (typeof value !== "string") {
		return (
			<span className="flex flex-wrap gap-x-2 gap-y-1">
				{value.map((one) => (
					<StepValue key={one} value={one} copy={copy} />
				))}
			</span>
		)
	}
	if (!copy) return <span className="text-foreground">{value}</span>
	return (
		<span className="inline-flex max-w-full items-start gap-0.5">
			<span className="min-w-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs/5 break-all text-foreground">
				{value}
			</span>
			<CopyButton value={value} label="value" toast={false} iconSize={12} className="size-6 shrink-0" />
		</span>
	)
}

type StepState = "done" | "todo" | "fix"

function StepMarker({ state, number }: { state: StepState; number: number }) {
	if (state === "done")
		return <CircleCheckIcon size={20} className="shrink-0 text-severity-info" aria-hidden />
	return (
		<span
			aria-hidden
			className={cn(
				"flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs font-medium",
				state === "fix"
					? "border-severity-error/40 bg-severity-error/12 text-severity-error"
					: "border-border text-muted-foreground",
			)}
		>
			{state === "fix" ? "!" : number}
		</span>
	)
}

/**
 * The console steps as one list, one open at a time. "Mark as done" is the reader's own progress,
 * kept while the dialog is open. A failed check opens the step it points at.
 */
export function GcpManualSteps({
	heading,
	detail,
	steps,
	failedStep,
	docsHref,
}: {
	heading: string
	detail: string
	steps: ReadonlyArray<GcpManualStep>
	failedStep: V2GcpSetupStep | null
	docsHref: string
}) {
	const [open, setOpen] = useState<V2GcpSetupStep | null>(failedStep ?? steps[0]?.id ?? null)
	const [done, setDone] = useState<ReadonlySet<V2GcpSetupStep>>(new Set())
	// A newer failure opens its step, once.
	const [shownFailure, setShownFailure] = useState(failedStep)
	if (failedStep !== shownFailure) {
		setShownFailure(failedStep)
		if (failedStep !== null) setOpen(failedStep)
	}
	const markDone = (id: V2GcpSetupStep) => {
		const next = new Set(done).add(id)
		setDone(next)
		setOpen(steps.find((step) => !next.has(step.id))?.id ?? null)
	}

	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<div className="flex flex-col gap-0.5">
					<h3 className={GCP_TITLE}>{heading}</h3>
					<p className={GCP_SMALL}>{detail}</p>
				</div>
				<span className="text-xs/5">
					<GcpExternalLink href={docsHref}>Full guide in the docs</GcpExternalLink>
				</span>
			</div>
			<ol className="divide-y divide-border/60 rounded-lg border">
				{steps.map((step, index) => {
					const state: StepState =
						step.id === failedStep ? "fix" : done.has(step.id) ? "done" : "todo"
					const expanded = open === step.id
					return (
						<li key={step.id} className={cn(state === "fix" && "bg-severity-error/4")}>
							<div className="flex items-center gap-3 px-4 py-3">
								<StepMarker state={state} number={index + 1} />
								<button
									type="button"
									aria-expanded={expanded}
									onClick={() => setOpen(expanded ? null : step.id)}
									className={cn(
										"min-w-0 flex-1 text-left text-sm outline-none focus-visible:underline",
										state === "done"
											? "text-muted-foreground"
											: "font-medium text-foreground",
									)}
								>
									{step.title}
								</button>
								{expanded ? (
									<a
										href={step.consoleUrl}
										target="_blank"
										rel="noreferrer"
										className="flex shrink-0 items-center gap-1 text-xs/5 font-medium hover:underline"
									>
										Open in console
										<ExternalLinkIcon size={12} aria-hidden />
									</a>
								) : (
									<span
										className={cn(
											"max-w-1/2 min-w-0 truncate font-mono text-xs",
											state === "fix" ? "text-severity-error" : "text-muted-foreground",
										)}
									>
										{state === "fix" ? "Needs a fix" : step.summary}
									</span>
								)}
								<button
									type="button"
									aria-label={expanded ? `Close ${step.title}` : `Open ${step.title}`}
									onClick={() => setOpen(expanded ? null : step.id)}
									className="shrink-0 text-muted-foreground"
								>
									<ChevronDownIcon
										size={14}
										aria-hidden
										className={cn("transition-transform", expanded && "rotate-180")}
									/>
								</button>
							</div>
							{expanded ? (
								<div className="flex flex-col gap-3 pr-4 pb-4 pl-12">
									<p className={GCP_SMALL}>{step.intro}</p>
									<dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-xs/5">
										{step.fields.map((field, fieldIndex) => (
											<div key={`${field.label}-${fieldIndex}`} className="contents">
												<dt className="text-muted-foreground">{field.label}</dt>
												<dd className="min-w-0">
													<StepValue value={field.value} copy={field.copy} />
												</dd>
											</div>
										))}
									</dl>
									{step.notes.length === 0 ? null : (
										<ul className="flex list-disc flex-col gap-1 pl-4 text-xs/5 text-pretty text-muted-foreground">
											{step.notes.map((note) => (
												<li key={note}>{note}</li>
											))}
										</ul>
									)}
									{done.has(step.id) ? null : (
										<div>
											<Button
												size="sm"
												variant="outline"
												onClick={() => markDone(step.id)}
											>
												<CheckIcon size={12} aria-hidden />
												Mark as done
											</Button>
										</div>
									)}
								</div>
							) : null}
						</li>
					)
				})}
			</ol>
		</section>
	)
}

const FILES = { terraform: "maple.tf", alchemy: "maple.ts" } as const

/** A block of text to read in place: the start in view, the rest on request. */
function TextBlock({ text, label, expanded }: { text: string; label: string; expanded: boolean }) {
	return (
		<div className="relative">
			<pre
				tabIndex={0}
				role="region"
				aria-label={label}
				className={cn(
					"p-3 font-mono text-xs/5 whitespace-pre-wrap outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
					expanded ? "max-h-96 overflow-auto" : "max-h-48 overflow-hidden",
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
	)
}

/**
 * The generated file to copy, its first lines in view. Copying the coding-agent prompt shows the
 * prompt in the file's place until the file is asked for again.
 */
export function GcpCodeCard({
	flavour,
	config,
	prompt,
	failure,
}: {
	flavour: "terraform" | "alchemy"
	config: string | null
	prompt: string | null
	failure: React.ReactNode
}) {
	const [expanded, setExpanded] = useState(false)
	const [promptShown, setPromptShown] = useState(false)
	const { copy, status } = useCopy({ label: "prompt", toast: false })
	const text = config?.trimEnd() ?? null
	const file = FILES[flavour]
	return (
		<div className="overflow-clip rounded-lg border">
			<div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
				<span className="font-mono text-xs text-muted-foreground">
					{promptShown ? "Prompt for a coding agent" : file}
					{text === null || promptShown
						? null
						: ` · ${countLabel(text.split("\n").length, "line")}`}
				</span>
				<span className="ml-auto flex items-center gap-2">
					<Button
						size="sm"
						variant="outline"
						disabled={prompt === null}
						onClick={() => {
							setPromptShown(true)
							void copy(prompt)
						}}
					>
						{promptShown && status === "copied" ? <CheckIcon size={12} aria-hidden /> : null}
						{promptShown && status === "copied"
							? "Prompt copied"
							: "Copy prompt for coding agent"}
					</Button>
					<CopyButton
						value={config ?? ""}
						disabled={config === null}
						label={file}
						idleLabel="Copy"
						toast={false}
						variant="default"
						size="sm"
						className="text-primary-foreground hover:text-primary-foreground"
					/>
				</span>
			</div>
			{failure !== null ? (
				<div className="p-3">{failure}</div>
			) : text === null || prompt === null ? (
				<div className="p-3">
					<Skeleton className="h-26 w-full" />
				</div>
			) : promptShown ? (
				<TextBlock
					text={prompt.trimEnd()}
					label="The prompt for a coding agent"
					expanded={expanded}
				/>
			) : (
				<TextBlock text={text} label={file} expanded={expanded} />
			)}
			<div className="flex items-center gap-3 border-t px-3 py-1.5 text-xs/5 text-muted-foreground">
				{promptShown ? (
					<>
						<span className="min-w-0 flex-1 text-pretty">
							{status === "error" ? "Couldn't copy: select the prompt and copy it." : "Copied."}{" "}
							It ends with the full {file}. No secrets.
						</span>
						<Button
							variant="link"
							size="xs"
							onClick={() => setPromptShown(false)}
							className="h-auto p-0 font-normal text-xs text-muted-foreground hover:text-foreground"
						>
							Back to {file}
						</Button>
					</>
				) : (
					<span className="flex min-w-0 flex-1 items-center gap-1.5 text-pretty">
						<LockIcon size={12} className="shrink-0" aria-hidden />
						No secrets in this file. Safe to commit.
					</span>
				)}
				{text === null ? null : (
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

/**
 * What waits on Google Cloud in a setup without the script: a row per capability, ticked as Maple
 * confirms it. Check access asks Maple to look now.
 */
export function GcpSetupChecks({
	checks,
	onCheck,
	checking,
	failure,
}: {
	checks: ReadonlyArray<GcpSetupCheck>
	onCheck: () => void
	checking: boolean
	/** The last check's failure, shown on the row it was for. */
	failure: string | null
}) {
	const done = checks.filter((check) => check.done).length
	const checkable = checks.find((check) => check.checkable)
	return (
		<div role="status" className="flex flex-col gap-3 border-t px-6 py-4">
			<div className="flex items-center gap-2.5">
				<Spinner className="size-3.5 shrink-0 text-severity-debug" />
				<p className="text-sm font-medium">Waiting for Google Cloud</p>
				<span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
					{done > 0 ? `${done} of ${checks.length} confirmed` : "updates on its own"}
				</span>
			</div>
			<ul className="flex flex-col gap-2 pl-6">
				{checks.map((check) => {
					const failed = failure !== null && check === checkable
					return (
						<li
							key={check.capability}
							className="grid grid-cols-[auto_11rem_1fr_auto] items-center gap-x-2.5 text-xs/5"
						>
							{check.done ? (
								<CircleCheckIcon size={14} className="text-severity-info" aria-hidden />
							) : failed ? (
								<span
									aria-hidden
									className="flex size-3.5 items-center justify-center rounded-full bg-severity-error/16 text-[10px] font-semibold text-severity-error"
								>
									!
								</span>
							) : (
								<span
									aria-hidden
									className="size-3.5 rounded-full border border-dashed border-muted-foreground/60"
								/>
							)}
							<span className="text-foreground">{check.title}</span>
							<span
								className={cn(
									"text-pretty",
									failed ? "text-severity-error" : "text-muted-foreground",
								)}
							>
								{failed ? "Check failed" : check.detail}
							</span>
							{check === checkable ? (
								<Button size="sm" variant="outline" loading={checking} onClick={onCheck}>
									{failure === null ? "Check access" : "Check again"}
								</Button>
							) : (
								<span />
							)}
						</li>
					)
				})}
			</ul>
			{failure === null ? null : (
				<p role="alert" className="pl-6 text-xs/5 text-pretty text-severity-error">
					{failure}
				</p>
			)}
		</div>
	)
}
