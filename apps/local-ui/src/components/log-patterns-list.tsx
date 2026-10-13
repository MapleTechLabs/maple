import { useMemo } from "react"
import type { LogPattern } from "@maple/query-engine/observability"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { rankCounts, severityBreakdown, splitTemplate } from "../lib/log-patterns"

const VISIBLE_SERVICES = 2

export function LogPatternsList({
	patterns,
	totalSampled,
	dimmed,
	onSelect,
}: {
	patterns: ReadonlyArray<LogPattern>
	totalSampled: number
	dimmed: boolean
	onSelect: (pattern: LogPattern) => void
}) {
	return (
		<ul
			aria-label="Log patterns"
			className={cn("h-full overflow-auto", dimmed && "opacity-60 transition-opacity")}
		>
			{patterns.map((pattern) => (
				<PatternRow
					key={pattern.template}
					pattern={pattern}
					share={totalSampled > 0 ? pattern.count / totalSampled : 0}
					onSelect={onSelect}
				/>
			))}
		</ul>
	)
}

function PatternRow({
	pattern,
	share,
	onSelect,
}: {
	pattern: LogPattern
	share: number
	onSelect: (pattern: LogPattern) => void
}) {
	const segments = useMemo(() => splitTemplate(pattern.template), [pattern.template])
	const severities = useMemo(() => severityBreakdown(pattern.severityCounts), [pattern.severityCounts])
	const services = useMemo(() => rankCounts(pattern.serviceCounts), [pattern.serviceCounts])
	const dominant = rankCounts(pattern.severityCounts)[0]?.name ?? "UNKNOWN"
	const percent = share * 100

	return (
		<li className="border-b">
			<button
				type="button"
				aria-label={`${pattern.count} logs: ${pattern.template.slice(0, 120)}`}
				title="Show matching logs"
				style={{ borderLeftWidth: "3px", borderLeftColor: getSeverityColor(dominant) }}
				className="flex w-full cursor-pointer items-center gap-4 px-4 py-2 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
				onClick={() => onSelect(pattern)}
			>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="truncate font-mono text-xs" title={pattern.template}>
						{segments.map((segment, i) =>
							segment.variable ? (
								<span key={i} className="text-muted-foreground/50">
									{segment.text}
								</span>
							) : (
								<span key={i}>{segment.text}</span>
							),
						)}
					</span>
					<div className="flex min-w-0 items-center gap-3 text-[11px] text-muted-foreground">
						<span className="flex shrink-0 items-center gap-2">
							{severities.map((entry) => (
								<span
									key={entry.name}
									className="font-semibold uppercase tabular-nums"
									style={{ color: getSeverityColor(entry.name) }}
								>
									{entry.name} {entry.count.toLocaleString()}
								</span>
							))}
						</span>
						<span
							className="hidden shrink-0 truncate lg:inline"
							title={services.map((s) => `${s.name} (${s.count})`).join(", ")}
						>
							{services
								.slice(0, VISIBLE_SERVICES)
								.map((s) => s.name)
								.join(", ")}
							{services.length > VISIBLE_SERVICES
								? ` +${services.length - VISIBLE_SERVICES}`
								: ""}
						</span>
						<span
							className="min-w-0 truncate font-mono text-muted-foreground/70"
							title={pattern.sample}
						>
							{pattern.sample}
						</span>
					</div>
				</div>
				<div className="flex w-28 shrink-0 flex-col items-end gap-1">
					<span className="font-mono text-xs tabular-nums">{pattern.count.toLocaleString()}</span>
					<div className="flex w-full items-center gap-1.5">
						<div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary/70"
								style={{ width: `${percent}%` }}
							/>
						</div>
						<span className="w-9 text-right text-[10px] text-muted-foreground tabular-nums">
							{percent < 1 ? "<1%" : `${Math.round(percent)}%`}
						</span>
					</div>
				</div>
			</button>
		</li>
	)
}
