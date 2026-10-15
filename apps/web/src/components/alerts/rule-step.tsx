import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"

export type RuleStepStatus = "done" | "missing" | "optional"

/** One numbered step of the rule editor; says "Required" until it is filled in. */
export function RuleStep({
	number,
	title,
	hint,
	status,
	actions,
	divider = true,
	children,
}: {
	number: number
	title: string
	hint?: string
	status: RuleStepStatus
	actions?: ReactNode
	/** A rule above the step; off for the first step and for steps sharing a row. */
	divider?: boolean
	children: ReactNode
}) {
	const headingId = `rule-step-${number}`
	return (
		<section aria-labelledby={headingId} className={cn("space-y-4", divider && "border-t pt-8")}>
			<div className="flex items-start justify-between gap-4">
				<div className="space-y-1">
					<div className="flex items-baseline gap-3">
						<h2
							id={headingId}
							className="font-display text-lg font-medium tracking-tight text-foreground"
						>
							<span className="mr-2.5 font-mono text-sm font-normal text-muted-foreground">
								{number}
							</span>
							{title}
						</h2>
						{status === "missing" && <span className="text-xs text-severity-warn">Required</span>}
					</div>
					{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
				</div>
				{actions}
			</div>
			{children}
		</section>
	)
}
