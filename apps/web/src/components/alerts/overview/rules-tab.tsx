import { Link } from "@tanstack/react-router"
import { useMemo, useState } from "react"

import type { AlertDestinationDocument, AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { DropdownMenuItem } from "@maple/ui/components/ui/dropdown-menu"
import { FilterChip } from "@maple/ui/components/ui/filter-chip"
import { LoadMoreButton } from "@maple/ui/components/ui/list-footer"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { countLabel } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { AlertsEmptyState } from "@/components/alerts/overview/alerts-empty-state"
import { FilteredEmpty } from "@/components/common/filtered-empty"
import { ROW_LINK_LIFT, ROW_STRETCHED_LINK_CLASS } from "@/components/common/data-table"
import { MagnifierIcon } from "@/components/icons"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import {
	type RibbonCell,
	type RuleBucket,
	ruleBucket,
	ruleConditionSummary,
	ruleHeadroom,
	ruleRibbon,
} from "@/lib/alerts/overview-derive"
import { type DerivedRuleStatus, worstState } from "@/lib/alerts/rule-status"
import { groupByTag, type TagGroup, UNTAGGED_KEY } from "@/lib/alerts/tag-grouping"
import type { AlertsOverviewReady } from "@/lib/models/alerts-overview-model"

const DAY_MS = 24 * 60 * 60 * 1000
const RIBBON_DAYS = 7
/** One cell per 6 hours. */
const RIBBON_CELLS = RIBBON_DAYS * 4
const FIRED_WINDOW_DAYS = 30
/** Rows rendered before "Show all"; an org can have a thousand rules. */
const RENDER_LIMIT = 100

const BUCKETS: ReadonlyArray<{ value: RuleBucket; label: string; tone: Tone }> = [
	{ value: "firing", label: "Firing", tone: "crit" },
	{ value: "blind", label: "Blind", tone: "warn" },
	{ value: "healthy", label: "Healthy", tone: "ok" },
	{ value: "disabled", label: "Disabled", tone: "neutral" },
]

const BUCKET_TONE: Record<RuleBucket, Tone> = {
	firing: "crit",
	blind: "warn",
	healthy: "ok",
	disabled: "neutral",
} satisfies Record<RuleBucket, Tone>

const ROW_GRID =
	"grid grid-cols-[12px_minmax(0,1fr)_170px_150px_minmax(0,160px)_48px_32px] items-center gap-4"

/** Cap the groups to `limit` rows in total, keeping group order. */
const capGroups = <T,>(groups: ReadonlyArray<TagGroup<T>>, limit: number): TagGroup<T>[] =>
	groups.reduce<{ out: TagGroup<T>[]; left: number }>(
		(acc, group) =>
			acc.left <= 0
				? acc
				: {
						out: [...acc.out, { ...group, items: group.items.slice(0, acc.left) }],
						left: acc.left - group.items.length,
					},
		{ out: [], left: limit },
	).out

export function RulesTab({
	data,
	destinations,
	isAdmin,
	serviceName,
	status,
	onStatusChange,
	isToggling,
	toggleFailed,
	onToggleRule,
}: {
	data: AlertsOverviewReady
	destinations: ReadonlyArray<AlertDestinationDocument>
	isAdmin: boolean
	serviceName: string | undefined
	status: RuleBucket | undefined
	onStatusChange: (status: RuleBucket | undefined) => void
	isToggling: boolean
	/** The last enable/disable write failed. */
	toggleFailed: boolean
	onToggleRule: (rule: AlertRuleDocument) => void
}) {
	const { rules, derivedByRuleId, incidentsByRule, timelineRange } = data
	const now = timelineRange.max
	const [query, setQuery] = useState("")
	const [showAll, setShowAll] = useState(false)

	const bucketByRuleId = useMemo(
		() => new Map(rules.map((rule) => [rule.id, ruleBucket(derivedByRuleId.get(rule.id))])),
		[rules, derivedByRuleId],
	)
	const bucketCounts = useMemo(() => {
		const counts = { firing: 0, blind: 0, healthy: 0, disabled: 0 } satisfies Record<RuleBucket, number>
		for (const bucket of bucketByRuleId.values()) counts[bucket]++
		return counts
	}, [bucketByRuleId])

	const firedByRuleId = useMemo(() => {
		const cutoff = now - FIRED_WINDOW_DAYS * DAY_MS
		return new Map(
			rules.map((rule) => [
				rule.id,
				(incidentsByRule.get(rule.id) ?? []).filter((i) => Date.parse(i.firstTriggeredAt) >= cutoff)
					.length,
			]),
		)
	}, [rules, incidentsByRule, now])
	const totalFired = [...firedByRuleId.values()].reduce((sum, n) => sum + n, 0)

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase()
		return rules.filter((rule) => {
			if (status !== undefined && bucketByRuleId.get(rule.id) !== status) return false
			if (q === "") return true
			return (
				rule.name.toLowerCase().includes(q) ||
				rule.serviceNames.some((s) => s.toLowerCase().includes(q)) ||
				rule.tags.some((t) => t.toLowerCase().includes(q))
			)
		})
	}, [rules, query, status, bucketByRuleId])

	const groups = useMemo(() => groupByTag(filtered, (rule) => rule.tags), [filtered])
	const totalRows = groups.reduce((sum, group) => sum + group.items.length, 0)
	const capped = !showAll && totalRows > RENDER_LIMIT
	const visibleGroups = capped ? capGroups(groups, RENDER_LIMIT) : groups

	const destinationsById = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations])
	const ribbonRange = { min: now - RIBBON_DAYS * DAY_MS, max: now }

	if (rules.length === 0) {
		return (
			<AlertsEmptyState
				isAdmin={isAdmin}
				hasDestinations={destinations.length > 0}
				serviceName={serviceName}
			/>
		)
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2">
				<SearchInput
					size="default"
					className="w-full max-w-xs"
					placeholder="Search rules, services, tags..."
					value={query}
					onValueChange={setQuery}
				/>
				{BUCKETS.map((bucket) => (
					<FilterChip
						key={bucket.value}
						dot
						tone={bucket.tone}
						pressed={status === bucket.value}
						onPressedChange={(pressed) => onStatusChange(pressed ? bucket.value : undefined)}
						count={bucketCounts[bucket.value]}
					>
						{bucket.label}
					</FilterChip>
				))}
				<span className="ml-auto font-mono text-xs text-muted-foreground">
					{countLabel(rules.length, "rule")} · {totalFired} fired in {FIRED_WINDOW_DAYS}d
				</span>
			</div>

			{toggleFailed && (
				<Alert variant="crit" size="sm">
					<AlertDescription>Failed to update the rule. Try again.</AlertDescription>
				</Alert>
			)}

			{filtered.length === 0 ? (
				<FilteredEmpty
					noun="rules"
					title="No rules match your filters"
					description="Try a different search term or status."
					icon={<MagnifierIcon size={18} />}
					onClear={() => {
						setQuery("")
						onStatusChange(undefined)
					}}
					className="py-12"
				/>
			) : (
				<div className="overflow-x-auto rounded-md border">
					<div className="min-w-[900px]">
						<div className={cn(ROW_GRID, "border-b px-4 py-2 text-xs text-muted-foreground")}>
							<span />
							<span>Rule</span>
							<span>Headroom now</span>
							<span>Last {RIBBON_DAYS} days</span>
							<span>Routes to</span>
							<span className="text-right">Fired {FIRED_WINDOW_DAYS}d</span>
							<span />
						</div>
						{visibleGroups.map((group) => {
							const firingInGroup = group.items.filter(
								(r) => bucketByRuleId.get(r.id) === "firing",
							).length
							return (
								<section key={group.key} className="border-b last:border-b-0">
									<div className="border-b bg-muted/30 px-4 py-2 text-xs">
										<span className="font-medium">
											{group.key === UNTAGGED_KEY ? "No tag" : group.label}
										</span>
										<span className="text-muted-foreground">
											{" "}
											{countLabel(group.count, "rule")}
											{firingInGroup > 0 && ` · ${firingInGroup} firing`}
										</span>
									</div>
									<ul className="divide-y">
										{group.items.map((rule) => (
											<RuleRow
												key={rule.id}
												rule={rule}
												derived={derivedByRuleId.get(rule.id)}
												bucket={bucketByRuleId.get(rule.id) ?? "healthy"}
												lastValue={
													worstState(data.statesByRule.get(rule.id) ?? [])
														?.last_value ?? null
												}
												incidents={incidentsByRule.get(rule.id) ?? []}
												ribbonRange={ribbonRange}
												destinations={rule.destinationIds
													.filter((id, i, all) => all.indexOf(id) === i)
													.map((id) => destinationsById.get(id))
													.filter(
														(d): d is AlertDestinationDocument => d !== undefined,
													)}
												fired={firedByRuleId.get(rule.id) ?? 0}
												isAdmin={isAdmin}
												isToggling={isToggling}
												onToggle={onToggleRule}
											/>
										))}
									</ul>
								</section>
							)
						})}
					</div>
				</div>
			)}
			{capped && (
				<div className="flex justify-center">
					<LoadMoreButton
						onClick={() => setShowAll(true)}
						label={`Show all ${totalRows.toLocaleString()}`}
					/>
				</div>
			)}
		</div>
	)
}

function RuleRow({
	rule,
	derived,
	bucket,
	lastValue,
	incidents,
	ribbonRange,
	destinations,
	fired,
	isAdmin,
	isToggling,
	onToggle,
}: {
	rule: AlertRuleDocument
	derived: DerivedRuleStatus | undefined
	bucket: RuleBucket
	lastValue: number | null
	incidents: ReadonlyArray<AlertIncidentDocument>
	ribbonRange: { min: number; max: number }
	destinations: ReadonlyArray<AlertDestinationDocument>
	fired: number
	isAdmin: boolean
	isToggling: boolean
	onToggle: (rule: AlertRuleDocument) => void
}) {
	return (
		<li className={cn(ROW_GRID, "relative px-4 py-3 hover:bg-muted/40")}>
			<StatusDot tone={BUCKET_TONE[bucket]} size="lg" />
			<div className="min-w-0 space-y-0.5">
				<Link
					to="/alerts/$ruleId"
					params={{ ruleId: rule.id }}
					className={cn(
						"block truncate text-sm font-medium",
						!rule.enabled && "text-muted-foreground",
						ROW_STRETCHED_LINK_CLASS,
					)}
					title={rule.name}
				>
					{rule.name}
				</Link>
				<p className="truncate font-mono text-xs text-muted-foreground">
					{ruleConditionSummary(rule)}
				</p>
			</div>
			<HeadroomMeter rule={rule} derived={derived} value={lastValue} />
			<StateRibbon cells={ruleRibbon(incidents, ribbonRange, RIBBON_CELLS)} />
			<RoutesTo destinations={destinations} enabled={rule.enabled} />
			<span
				className={cn(
					"text-right font-mono text-xs tabular-nums",
					fired === 0 && "text-muted-foreground",
				)}
			>
				{fired}
			</span>
			<span className={ROW_LINK_LIFT}>
				{isAdmin && (
					<RowActionsMenu label={`Actions for ${rule.name}`}>
						<DropdownMenuItem render={<Link to="/alerts/$ruleId" params={{ ruleId: rule.id }} />}>
							Open rule
						</DropdownMenuItem>
						<DropdownMenuItem disabled={isToggling} onClick={() => onToggle(rule)}>
							{rule.enabled ? "Disable rule" : "Enable rule"}
						</DropdownMenuItem>
					</RowActionsMenu>
				)}
			</span>
		</li>
	)
}

function HeadroomMeter({
	rule,
	derived,
	value,
}: {
	rule: AlertRuleDocument
	derived: DerivedRuleStatus | undefined
	value: number | null
}) {
	if (!rule.enabled) return <span className="text-xs text-muted-foreground">Not evaluating</span>
	if (derived?.status === "error")
		return <span className="text-xs text-severity-error">Query fails to run</span>
	if (value === null) return <span className="text-xs text-muted-foreground">Waiting on data</span>

	const meter = ruleHeadroom(rule, value)
	const tone = meter.breached
		? "bg-severity-error"
		: meter.headroom !== null && meter.headroom < 0.2
			? "bg-severity-warn"
			: "bg-severity-info"
	const label = meter.breached
		? "over threshold"
		: meter.headroom !== null
			? `${Math.round(meter.headroom * 100)}% headroom`
			: "within threshold"

	return (
		<div className="min-w-0 space-y-1">
			<div className="relative h-1.5 rounded-full bg-muted">
				<span
					className={cn("absolute inset-y-0 left-0 rounded-full", tone)}
					style={{ width: `${meter.fill * 100}%` }}
				/>
				{meter.ticks.map((tick) => (
					<span
						key={tick}
						aria-hidden
						className="absolute -top-0.5 h-2.5 w-px bg-foreground/70"
						style={{ left: `${tick * 100}%` }}
					/>
				))}
			</div>
			<p
				className={cn(
					"truncate font-mono text-2xs",
					meter.breached ? "text-severity-error" : "text-muted-foreground",
				)}
			>
				{formatSignalValue(rule.signalType, value)} · {label}
			</p>
		</div>
	)
}

const RIBBON_CLASS: Record<RibbonCell, string> = {
	quiet: "bg-muted",
	warning: "bg-severity-warn",
	critical: "bg-severity-error",
} satisfies Record<RibbonCell, string>

function StateRibbon({ cells }: { cells: ReadonlyArray<RibbonCell> }) {
	return (
		<div className="flex h-3.5 items-stretch gap-px" aria-label="Incidents over the last 7 days">
			{cells.map((cell, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional ribbon
				<span key={i} className={cn("flex-1 rounded-[1px]", RIBBON_CLASS[cell])} />
			))}
		</div>
	)
}

function RoutesTo({
	destinations,
	enabled,
}: {
	destinations: ReadonlyArray<AlertDestinationDocument>
	enabled: boolean
}) {
	if (destinations.length === 0) {
		return (
			<span className={cn("text-xs", enabled ? "text-severity-warn" : "text-muted-foreground")}>
				Nobody
			</span>
		)
	}
	const names = destinations.map((d) => d.name).join(", ")
	return (
		<span className="truncate text-xs" title={names}>
			{names}
		</span>
	)
}
