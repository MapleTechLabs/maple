import { cn } from "@maple/ui/lib/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { TONE_FILL, TONE_SOFT } from "@maple/ui/lib/tone"

import type { ReleaseHealth } from "./release-model"

export const RELEASE_HEALTH_LABEL = {
	regressed: "errors up",
	watch: "latency up",
	rolling: "rolling out",
	healthy: "healthy",
} satisfies Record<ReleaseHealth, string>

export const RELEASE_HEALTH_DESCRIPTION = {
	regressed: "Errors at least twice as often as the version it replaced on the same service.",
	watch: "p95 latency up by a quarter or more against the version it replaced.",
	rolling: "The newest version of its service, not yet carrying the whole of the latest traffic.",
	healthy:
		"No change worth flagging against the version it replaced, or no earlier version in the window to compare with.",
} satisfies Record<ReleaseHealth, string>

/** Marker fill for the swimlanes and the filter legend. */
export const RELEASE_HEALTH_DOT_CLASS = {
	regressed: TONE_FILL.crit,
	watch: TONE_FILL.warn,
	rolling: "border-2 border-primary bg-background",
	healthy: "bg-primary/70",
} satisfies Record<ReleaseHealth, string>

const PILL_CLASS = {
	regressed: TONE_SOFT.crit,
	watch: TONE_SOFT.warn,
	rolling: "bg-primary/10 text-primary",
	healthy: TONE_SOFT.neutral,
} satisfies Record<ReleaseHealth, string>

interface ReleaseHealthPillProps {
	health: ReleaseHealth
	/** Replaces the generic label with the measured figure ("errors 4.1×", "p95 +38%"). */
	label?: string
	className?: string
}

export function ReleaseHealthPill({ health, label, className }: ReleaseHealthPillProps) {
	return (
		<Badge
			size="xs"
			pill
			mono
			title={RELEASE_HEALTH_DESCRIPTION[health]}
			className={cn("cursor-default font-normal", PILL_CLASS[health], className)}
		>
			{label ?? RELEASE_HEALTH_LABEL[health]}
		</Badge>
	)
}

/** "errors 4.1×" / "p95 +38%" / "42% rolling out" — the figure behind the band. */
export function releaseHealthFigure(impact: {
	health: ReleaseHealth
	errorRatio: number | undefined
	p95Delta: number | undefined
	share: number | undefined
}): string | undefined {
	switch (impact.health) {
		case "regressed":
			return impact.errorRatio === undefined
				? undefined
				: Number.isFinite(impact.errorRatio)
					? `errors ${impact.errorRatio.toFixed(1)}×`
					: "errors from 0"
		case "watch":
			return impact.p95Delta === undefined ? undefined : `p95 +${Math.round(impact.p95Delta * 100)}%`
		case "rolling":
			return impact.share === undefined ? undefined : `${Math.round(impact.share * 100)}% rolling out`
		case "healthy":
			return undefined
	}
}
