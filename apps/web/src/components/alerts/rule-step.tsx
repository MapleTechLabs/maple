import type { ReactNode } from "react"

export type RuleStepStatus = "done" | "missing" | "optional"

/** One numbered step of the rule editor; says "Required" until it is filled in. */
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
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h2 id={headingId} className="text-sm font-medium text-foreground">
					<span className="mr-2 font-mono text-muted-foreground">{number}</span>
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
