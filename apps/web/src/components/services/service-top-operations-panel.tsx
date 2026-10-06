import { useMemo } from "react"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { Sparkline } from "@maple/ui/components/ui/gradient-chart"
import { BackdropBar } from "@maple/ui/components/ui/meter"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { getServiceOperationsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { LatencyValue } from "@maple/ui/components/latency-value"
import type { ServiceOperation } from "@/api/warehouse/service-operations"
import { SectionCard } from "./section-card"
import { callsPerSecond, serviceOperationsQueryInput, windowSeconds } from "./service-operations"
import { ViewAllButton } from "./view-all-button"
import { formatThroughput } from "@maple/ui/lib/format"
import { SampledValue } from "./sampled-value"
import { ErrorRateValue } from "@maple/ui/components/error-rate-value"

const PANEL_LIMIT = 5

interface ServiceTopOperationsPanelProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
	/** Switches the page to the Operations tab (URL-driven). */
	onViewAll: () => void
}

/**
 * "Top operations" digest on the Overview tab: the service's busiest span names
 * with rate/error/p95 at a glance. Reads the same atom key the Operations tab
 * fetches, so opening that tab afterwards is a cache hit. Quiet by design —
 * renders nothing while loading or when the service has no operations.
 */
export function ServiceTopOperationsPanel({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	onViewAll,
}: ServiceTopOperationsPanelProps) {
	const result = useRefreshableAtomValue(
		getServiceOperationsResultAtom({
			data: serviceOperationsQueryInput({
				serviceName,
				effectiveStartTime,
				effectiveEndTime,
				environments,
			}),
		}),
	)

	const operations = useMemo<ServiceOperation[]>(
		() =>
			Result.builder(result)
				.onSuccess((r) => r.operations.slice(0, PANEL_LIMIT))
				.orElse(() => []),
		[result],
	)

	if (operations.length === 0) return null

	const seconds = windowSeconds(effectiveStartTime, effectiveEndTime)
	const isWaiting = Result.isSuccess(result) && result.waiting
	const maxCalls = operations.reduce((acc, op) => Math.max(acc, op.estimatedSpanCount), 0)

	return (
		<SectionCard
			title="Top operations"
			className={refreshingClass(isWaiting)}
			action={<ViewAllButton onClick={onViewAll} />}
		>
			<ul className="divide-y">
				{operations.map((op) => {
					return (
						<li key={op.spanName}>
							<button
								type="button"
								onClick={onViewAll}
								className="relative flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
							>
								<BackdropBar
									value={op.estimatedSpanCount}
									max={maxCalls}
									className="bg-severity-info/10"
								/>
								<TruncatedText
									text={op.spanName}
									mono
									className="relative flex-1 text-xs text-foreground"
								/>
								<span className="relative flex shrink-0 items-center gap-3 font-mono text-2xs tabular-nums">
									<SampledValue
										className="text-foreground"
										estimated={op.estimatedSpanCount > op.spanCount}
										value={formatThroughput(
											callsPerSecond(op.estimatedSpanCount, seconds),
											"/s",
										)}
									/>
									<ErrorRateValue rate={op.errorRate} />
									<LatencyValue ms={op.p95DurationMs} scale="p95" />
								</span>
								{/*
									The responsive `hidden`/`sm:block` lives on a WRAPPER, never on the
									chart itself: `PlotFrame` merges the caller's className over its own
									`flex flex-col` with tailwind-merge, so a display utility passed
									through silently deletes that `flex` — the plot box's `flex-1` goes
									inert, it takes its height from its content instead, and the chart
									locks at the 320px pre-measurement fallback, spilling over the rows
									below.
								*/}
								<div className="relative hidden shrink-0 sm:block">
									<Sparkline
										data={op.sparkline.map((point) => ({ value: point.count }))}
										className="h-5 w-[88px]"
									/>
								</div>
							</button>
						</li>
					)
				})}
			</ul>
		</SectionCard>
	)
}
