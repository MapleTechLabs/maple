import { Spinner } from "@maple/ui/components/ui/spinner"
import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"
import { CircleCheckIcon, CircleWarningIcon } from "@/components/icons"
import type { SetupStep } from "./planetscale-setup-steps"

/** A step of any integration's checklist: PlanetScale's, with its own ids and a rendered detail. */
export interface ChecklistStep<Id extends string> extends Omit<SetupStep, "id" | "detail"> {
	readonly id: Id
	readonly detail: ReactNode
}

/**
 * A progression rendered as an ordered checklist: PlanetScale's four setup steps, Google
 * Cloud's setup and disconnect steps.
 *
 * Only an active step expands — a fully-connected org sees quiet confirmation lines, not a
 * form. `actions` is keyed by step id so the caller
 * supplies the action (the token form, a Reconnect button) without this
 * component knowing what any step needs.
 */
export function PlanetScaleSetupChecklist<Id extends string>({
	steps,
	actions,
	stacked = false,
	className,
}: {
	steps: ReadonlyArray<ChecklistStep<Id>>
	/** Per-step action UI, rendered only while that step is `current` or `blocked`. */
	actions?: Partial<Record<Id, ReactNode>>
	/** Puts each detail under its title: for details that are sentences, not a few words. */
	stacked?: boolean
	className?: string
}) {
	return (
		<ol className={cn("flex flex-col", className)}>
			{steps.map((step, index) => {
				const action =
					step.state === "current" || step.state === "blocked" ? actions?.[step.id] : null
				return (
					<li
						key={step.id}
						className="flex gap-3 border-b border-border/60 py-2.5 last:border-b-0 last:pb-0 first:pt-0"
					>
						<StepMarker step={step} number={index + 1} />
						<div className="min-w-0 flex-1">
							<div
								className={cn(
									"flex",
									stacked ? "flex-col gap-0.5" : "flex-wrap items-baseline gap-x-2",
								)}
							>
								<span
									className={cn(
										"text-xs font-medium",
										step.state === "pending"
											? "text-muted-foreground"
											: "text-foreground",
									)}
								>
									{step.title}
								</span>
								<span
									className={cn(
										"text-xs",
										step.state === "blocked"
											? "text-severity-error"
											: "text-muted-foreground",
									)}
								>
									{step.detail}
								</span>
							</div>
							{action !== null && action !== undefined ? (
								<div className="mt-2.5">{action}</div>
							) : null}
						</div>
					</li>
				)
			})}
		</ol>
	)
}

/**
 * One glyph per state. The pending marker keeps the step *number* rather than a
 * generic dot — on a four-step list the number is what tells you how much is
 * left. A spinner appears only when Maple is the one working: spinning next to a
 * step that is waiting on a paste reads as "don't touch this".
 */
function StepMarker({ step, number }: { step: Pick<SetupStep, "state" | "waitingOnMaple">; number: number }) {
	if (step.state === "done") {
		return <CircleCheckIcon size={14} className="mt-0.5 shrink-0 text-severity-info" aria-hidden />
	}
	if (step.state === "blocked") {
		return <CircleWarningIcon size={14} className="mt-0.5 shrink-0 text-severity-error" aria-hidden />
	}
	if (step.state === "current") {
		return step.waitingOnMaple ? (
			<Spinner size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
		) : (
			<span
				aria-hidden
				className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full bg-primary text-4xs font-medium text-primary-foreground"
			>
				{number}
			</span>
		)
	}
	return (
		<span
			aria-hidden
			className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border border-border text-4xs font-medium text-muted-foreground"
		>
			{number}
		</span>
	)
}
