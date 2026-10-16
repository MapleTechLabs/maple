import { Link } from "@tanstack/react-router"

import type { AlertRuleDocument } from "@maple/domain/http"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { countLabel } from "@maple/ui/lib/format"
import { formatRelativeShortFrom } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"

import { ROW_STRETCHED_LINK_CLASS } from "@/components/common/data-table"
import { displaySignalType, formatSignalValue } from "@/lib/alerts/form-utils"
import type { RuleHeadroom } from "@/lib/alerts/headroom"

const MAX_ROWS = 8
const ROW_GRID = "grid grid-cols-[minmax(0,220px)_minmax(0,1fr)_130px_44px] items-center gap-4"

/** Formats a rule's values in the unit its threshold is entered in. */
function ruleValue(rule: AlertRuleDocument, value: number): string {
	const draft = rule.queryBuilderDraft
	return formatSignalValue(
		displaySignalType({
			signalType: rule.signalType,
			queryBuilderDraft:
				draft == null
					? undefined
					: { dataSource: draft.dataSource ?? "", aggregation: draft.aggregation ?? "" },
		}),
		value,
	)
}

/**
 * The quiet inbox's main read: how close every rule is to firing, nearest
 * first. One flat meter per rule, filled toward its threshold.
 */
export function HeadroomList({ rows, now }: { rows: ReadonlyArray<RuleHeadroom>; now: number }) {
	const shown = rows.slice(0, MAX_ROWS)
	const hidden = rows.length - shown.length
	return (
		<section className="space-y-3">
			<div className="flex items-baseline justify-between gap-4">
				<Eyebrow as="h3">Headroom</Eyebrow>
				<span className="font-mono text-xs text-muted-foreground">
					latest check against each threshold
				</span>
			</div>
			{shown.length === 0 ? (
				<p className="border-t py-4 text-sm text-muted-foreground">
					No rule has reported a value yet. The first checks land within a minute.
				</p>
			) : (
				<ul className="divide-y border-y">
					{shown.map((row) => (
						<HeadroomRow key={row.rule.id} row={row} now={now} />
					))}
				</ul>
			)}
			{hidden > 0 && (
				<p className="font-mono text-2xs text-muted-foreground">
					+ {countLabel(hidden, "more rule")}
				</p>
			)}
		</section>
	)
}

function HeadroomRow({ row, now }: { row: RuleHeadroom; now: number }) {
	const { rule, closeness } = row
	const near = closeness !== null && closeness >= 0.75
	const floor = rule.comparator === "lt" || rule.comparator === "lte"
	return (
		<li className={cn(ROW_GRID, "relative py-2.5 hover:bg-muted/40")}>
			<div className="min-w-0">
				<Link
					to="/alerts/$ruleId"
					params={{ ruleId: rule.id }}
					className={cn("block truncate text-sm", ROW_STRETCHED_LINK_CLASS)}
					title={rule.name}
				>
					{rule.name}
				</Link>
				{row.groupKey !== null && (
					<p className="truncate font-mono text-2xs text-muted-foreground">{row.groupKey}</p>
				)}
			</div>
			{/* Decorative: the value column beside it says the same in words. */}
			<div className="relative h-2 rounded-xs bg-muted/60" aria-hidden>
				{closeness !== null && (
					<span
						className={cn(
							"absolute inset-y-0 left-0 rounded-xs",
							near ? "bg-severity-warn" : "bg-muted-foreground/45",
						)}
						style={{ width: `${Math.max(closeness * 100, 1.5)}%` }}
					/>
				)}
				{/* The threshold sits at the right edge; the tick wears the rule's severity. */}
				<span
					aria-hidden
					className={cn(
						"absolute -inset-y-1 right-0 w-0.5 rounded-full",
						rule.severity === "critical" ? "bg-severity-error" : "bg-severity-warn",
					)}
				/>
			</div>
			<span className="truncate text-right font-mono text-xs tabular-nums">
				<span className={near ? "text-severity-warn" : undefined}>{ruleValue(rule, row.value)}</span>
				<span className="text-muted-foreground">
					{floor ? " / min " : " / "}
					{ruleValue(rule, rule.threshold)}
				</span>
			</span>
			<span className="text-right font-mono text-2xs text-muted-foreground">
				{row.checkedAt === null ? "" : formatRelativeShortFrom(row.checkedAt, now)}
			</span>
		</li>
	)
}
