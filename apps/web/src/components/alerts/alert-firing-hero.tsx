import { Card, CardContent } from "@maple/ui/components/ui/card"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { pluralize } from "@maple/ui/lib/format"
import { TONE_FILL, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

/* -------------------------------------------------------------------------- */
/*  Status bar — flat one-row treatment that leads the Monitor / dashboard     */
/* -------------------------------------------------------------------------- */

export function AlertFiringHero({
	openCount,
	criticalCount,
	warningCount,
	rulesEnabled,
	rulesTotal,
	lastEvaluatedHint,
}: {
	openCount: number
	criticalCount: number
	warningCount: number
	rulesEnabled: number
	rulesTotal: number
	lastEvaluatedHint?: string
}) {
	const firing = openCount > 0

	const rulesSummary = (
		<span className="tabular-nums">
			<span className="text-foreground font-medium">{rulesEnabled}</span>
			<span className="text-muted-foreground/70">/</span>
			<span>{rulesTotal}</span>
			<span className="ml-1">rules</span>
		</span>
	)

	if (!firing) {
		return (
			<Card>
				<CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
					<div className="flex min-w-0 items-center gap-3">
						<StatusDot tone="ok" />
						<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
							<span className="text-base font-semibold tracking-tight">All clear</span>
							<span className="text-muted-foreground text-sm">
								<span className="text-foreground font-medium tabular-nums">
									{rulesEnabled}
								</span>
								<span className="text-muted-foreground/70"> / </span>
								<span className="tabular-nums">{rulesTotal}</span>
								<span className="ml-1">rules watching</span>
							</span>
						</div>
					</div>
					{lastEvaluatedHint && (
						<span className="text-muted-foreground shrink-0 text-xs">{lastEvaluatedHint}</span>
					)}
				</CardContent>
			</Card>
		)
	}

	const firingLabel =
		[criticalCount > 0 && `${criticalCount} critical`, warningCount > 0 && `${warningCount} warning`]
			.filter(Boolean)
			.join(" · ") || `${openCount} open`

	return (
		<Card className="border-severity-error/30 bg-severity-error/[0.04]">
			<CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
				<div className="flex min-w-0 items-center gap-3">
					<StatusDot tone="crit" />
					<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
						<Eyebrow variant="label" className="text-severity-error">
							Firing now
						</Eyebrow>
						<span className="flex items-baseline gap-1.5">
							<span className="text-severity-error text-2xl font-semibold tabular-nums leading-none">
								{openCount}
							</span>
							<span className="text-muted-foreground text-sm">
								{pluralize(openCount, "incident")}
							</span>
						</span>
						<span className="text-muted-foreground/40">·</span>
						<span className="text-muted-foreground text-sm">{firingLabel}</span>
					</div>
				</div>
				<div className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
					{rulesSummary}
					{lastEvaluatedHint && (
						<>
							<span className="text-muted-foreground/40">·</span>
							<span>{lastEvaluatedHint}</span>
						</>
					)}
				</div>
			</CardContent>
		</Card>
	)
}

/** Severity beacon: a static dot in the stat's tone. */
function StatusDot({ tone }: { tone: Extract<Tone, "ok" | "crit"> }) {
	return (
		<span className="relative flex size-3 shrink-0 items-center justify-center">
			<span className={cn("relative size-2 rounded-full", TONE_FILL[tone])} />
		</span>
	)
}
