import { useId, useState } from "react"
import type React from "react"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { Radio, RadioGroup } from "@maple/ui/components/ui/radio-group"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { cn } from "@maple/ui/lib/utils"

import { ChevronDownIcon, ExternalLinkIcon } from "@/components/icons"

import { GCP_SMALL, GCP_TITLE, GcpExternalLink } from "./gcp-primitives"
import type { GcpManualStep, GcpSetupMethod, GcpStepField } from "./gcp-setup-steps"

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

const HINTS = { terraform: "maple.tf for the google provider", alchemy: "maple.ts for alchemy/GCP" } as const

/** The Method step's choice: one row per way to connect, the code flavour under its row. */
export function GcpMethodChoice({
	method,
	onMethod,
	changing,
}: {
	method: GcpSetupMethod
	onMethod: (method: GcpSetupMethod) => void
	/** Something of the connection is set up already: the choice applies a change. */
	changing: boolean
}) {
	const id = useId()
	const row = method === "terraform" || method === "alchemy" ? "code" : method
	const flavour = method === "alchemy" ? "alchemy" : "terraform"
	return (
		<fieldset className="flex flex-col gap-3">
			<legend className={cn(GCP_TITLE, "mb-3")}>
				{changing ? "How do you want to apply the change?" : "How do you want to connect?"}
			</legend>
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
										<ToggleGroupItem value="alchemy">Alchemy</ToggleGroupItem>
									</ToggleGroup>
									<span className={GCP_SMALL}>{HINTS[flavour]}</span>
								</div>
							</div>
						) : null}
					</div>
				))}
			</RadioGroup>
		</fieldset>
	)
}

/** An exact name in mono with its copy button, or a setting in words. */
export function GcpValue({ value, copy = true }: { value: GcpStepField["value"]; copy?: boolean }) {
	if (typeof value !== "string") {
		return (
			<span className="flex flex-wrap gap-x-2 gap-y-1">
				{value.map((one) => (
					<GcpValue key={one} value={one} copy={copy} />
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

/** The console steps as one list, one open at a time. */
export function GcpManualSteps({
	heading,
	detail,
	steps,
	docsHref,
}: {
	heading: string
	detail: React.ReactNode
	steps: ReadonlyArray<GcpManualStep>
	docsHref: string
}) {
	const [open, setOpen] = useState<string | null>(steps[0]?.title ?? null)
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
					const expanded = open === step.title
					return (
						<li key={step.title}>
							<div className="flex items-center gap-3 px-4 py-3">
								<span
									aria-hidden
									className="flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs font-medium text-muted-foreground"
								>
									{index + 1}
								</span>
								<button
									type="button"
									aria-expanded={expanded}
									onClick={() => setOpen(expanded ? null : step.title)}
									className="flex min-w-0 flex-1 items-center gap-3 text-left text-sm font-medium outline-none focus-visible:underline"
								>
									<span className="min-w-0 flex-1">{step.title}</span>
									{expanded ? null : (
										<span className="max-w-1/2 min-w-0 truncate font-mono text-xs font-normal text-muted-foreground">
											{step.summary}
										</span>
									)}
									<ChevronDownIcon
										size={14}
										aria-hidden
										className={cn(
											"shrink-0 text-muted-foreground transition-transform",
											expanded && "rotate-180",
										)}
									/>
								</button>
							</div>
							{expanded ? (
								<div className="flex flex-col gap-3 pr-4 pb-4 pl-12">
									<p className={GCP_SMALL}>
										{step.intro}{" "}
										<a
											href={step.consoleUrl}
											target="_blank"
											rel="noreferrer"
											className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
										>
											Open in console
											<ExternalLinkIcon size={12} aria-hidden />
										</a>
									</p>
									<dl className="grid grid-cols-1 items-baseline gap-x-4 gap-y-1 text-xs/5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-y-2">
										{step.fields.map((field) => (
											<div key={field.label} className="contents">
												<dt className="text-muted-foreground">{field.label}</dt>
												<dd className="min-w-0">
													<GcpValue value={field.value} copy={field.copy} />
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
								</div>
							) : null}
						</li>
					)
				})}
			</ol>
		</section>
	)
}
