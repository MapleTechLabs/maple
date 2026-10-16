import { useMemo } from "react"

import type { AlertIncidentDocument, AlertRulePreviewResponse } from "@maple/domain/http"
import { UNGROUPED_GROUP_KEY } from "@maple/domain/http"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { breachStatsFromPreview, formatBreachDuration } from "@/lib/alerts/breach-stats"
import { formatSignalValue, type RuleFormState, displaySignalType } from "@/lib/alerts/form-utils"
import type { RuleFieldChange } from "@/lib/alerts/preview-insights"

interface RuleEditImpactProps {
	/** The saved rule replayed over the same window as the draft. */
	savedPreview: AlertRulePreviewResponse | null
	savedLoading: boolean
	draftPreview: AlertRulePreviewResponse | null
	draftLoading: boolean
	changes: readonly RuleFieldChange[]
	clearedIncidents: readonly AlertIncidentDocument[]
	form: RuleFormState
	/** The chart's domain in epoch ms, so the fire marks line up with the axis below. */
	domain: { min: number; max: number }
}

/**
 * Edit mode's answer to "what does this change do": the saved rule and the
 * draft replayed over the same window, fire for fire, plus every changed field
 * and the open incidents the draft would no longer hold.
 */
export function RuleEditImpact({
	savedPreview,
	savedLoading,
	draftPreview,
	draftLoading,
	changes,
	clearedIncidents,
	form,
	domain,
}: RuleEditImpactProps) {
	const before = useMemo(() => breachStatsFromPreview(savedPreview), [savedPreview])
	const after = useMemo(() => breachStatsFromPreview(draftPreview), [draftPreview])
	const loading = savedLoading || draftLoading
	const delta = after.breachCount - before.breachCount
	const display = displaySignalType(form)

	return (
		<div className="space-y-3 border-b px-4 pt-3 pb-4">
			<Eyebrow variant="label">
				Before and after · {changes.length} unsaved {changes.length === 1 ? "change" : "changes"}
			</Eyebrow>
			{loading ? (
				<Skeleton className="h-14 w-full" />
			) : (
				<div className="flex flex-wrap gap-x-10 gap-y-3">
					<Figure
						before={String(before.breachCount)}
						after={`${after.breachCount} ${after.breachCount === 1 ? "alert" : "alerts"}`}
						caption={
							delta === 0
								? "Same number of alerts in this window"
								: `${Math.abs(delta)} ${delta < 0 ? "fewer" : "more"} than the saved rule`
						}
						tone={delta < 0 ? "good" : delta > 0 ? "warn" : "neutral"}
					/>
					<Figure
						before={formatBreachDuration(before.longestRunMs)}
						after={formatBreachDuration(after.longestRunMs)}
						caption="longest time firing"
						tone="neutral"
					/>
				</div>
			)}

			<div className="space-y-1">
				<FireRail label="before" preview={savedPreview} domain={domain} tone="muted" />
				<FireRail label="after" preview={draftPreview} domain={domain} tone="crit" />
			</div>

			<ul className="flex flex-wrap gap-1.5 text-xs">
				{changes.map((change) => (
					<li key={change.field} className="rounded-sm border bg-muted/30 px-2 py-1">
						<span className="text-muted-foreground">{change.field} </span>
						<span className="font-mono text-muted-foreground line-through">{change.before}</span>
						<span className="text-muted-foreground"> → </span>
						<span className="font-mono">{change.after}</span>
					</li>
				))}
			</ul>

			{clearedIncidents.length > 0 && (
				<div className="border-l-2 border-severity-warn py-0.5 pl-3 text-xs">
					<p className="text-foreground">
						{clearedIncidents.length} open{" "}
						{clearedIncidents.length === 1 ? "incident" : "incidents"} would clear under this edit
					</p>
					<ul className="mt-0.5 text-muted-foreground">
						{clearedIncidents.slice(0, 3).map((incident) => (
							<li key={incident.id}>
								{incident.groupKey === null || incident.groupKey === UNGROUPED_GROUP_KEY
									? incident.ruleName
									: incident.groupKey}
								{incident.lastObservedValue !== null &&
									` at ${formatSignalValue(display, incident.lastObservedValue)}`}
							</li>
						))}
						{clearedIncidents.length > 3 && <li>and {clearedIncidents.length - 3} more</li>}
					</ul>
					<p className="mt-0.5 text-muted-foreground">
						Takes effect on the next check after saving.
					</p>
				</div>
			)}
		</div>
	)
}

function Figure({
	before,
	after,
	caption,
	tone,
}: {
	before: string
	after: string
	caption: string
	tone: "good" | "warn" | "neutral"
}) {
	return (
		<div>
			<p className="flex items-baseline gap-2 text-2xl font-medium tabular-nums">
				<span className="text-muted-foreground line-through decoration-1">{before}</span>
				<span
					className={cn(
						tone === "good" && "text-severity-info",
						tone === "warn" && "text-severity-warn",
					)}
				>
					{after}
				</span>
			</p>
			<p className="text-xs text-muted-foreground">{caption}</p>
		</div>
	)
}

/** One row of would-fire marks across the window, placed by start time. */
function FireRail({
	label,
	preview,
	domain,
	tone,
}: {
	label: string
	preview: AlertRulePreviewResponse | null
	domain: { min: number; max: number }
	tone: "muted" | "crit"
}) {
	const span = Math.max(domain.max - domain.min, 1)
	const marks = (preview?.wouldFire ?? []).flatMap((fire) => {
		const start = Date.parse(fire.start)
		const end = Date.parse(fire.end)
		if (!Number.isFinite(start) || !Number.isFinite(end)) return []
		const left = Math.min(Math.max((start - domain.min) / span, 0), 1)
		const width = Math.max((end - start) / span, 0.004)
		return [{ key: `${fire.groupKey}:${fire.start}`, left, width: Math.min(width, 1 - left) }]
	})
	return (
		<div className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-2">
			<span className="text-right text-2xs text-muted-foreground">{label}</span>
			<div
				className="relative h-2 rounded-sm bg-muted/50"
				aria-label={`${label}: ${marks.length} alerts`}
			>
				{marks.map((mark) => (
					<span
						key={mark.key}
						className={cn(
							"absolute inset-y-0 min-w-0.5 rounded-[1px]",
							tone === "crit" ? "bg-severity-error" : "bg-muted-foreground/60",
						)}
						style={{ left: `${mark.left * 100}%`, width: `${mark.width * 100}%` }}
					/>
				))}
			</div>
		</div>
	)
}
