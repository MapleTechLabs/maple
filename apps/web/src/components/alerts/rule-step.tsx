import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"

import { CheckIcon } from "@/components/icons"

export type RuleStepStatus = "done" | "missing" | "optional"

/** One numbered step of the rule editor: what it asks for, and whether it is filled in. */
export function RuleStep({
	number,
	title,
	hint,
	status,
	actions,
	children,
}: {
	number: number
	title: string
	hint?: string
	status: RuleStepStatus
	actions?: ReactNode
	children: ReactNode
}) {
	const headingId = `rule-step-${number}`
	return (
		<section aria-labelledby={headingId} className="space-y-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span
					aria-hidden
					className={cn(
						"flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs",
						status === "done"
							? "border-primary bg-primary text-primary-foreground"
							: "border-border text-muted-foreground",
					)}
				>
					{status === "done" ? <CheckIcon size={12} /> : number}
				</span>
				<h2 id={headingId} className="text-sm font-medium text-foreground">
					{title}
				</h2>
				{status === "missing" && <span className="text-xs text-severity-warn">Required</span>}
				{hint && <p className="min-w-0 flex-1 text-xs text-muted-foreground">{hint}</p>}
				{actions}
			</div>
			{children}
		</section>
	)
}
