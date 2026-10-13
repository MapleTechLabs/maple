import * as React from "react"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { BackdropBar } from "@maple/ui/components/ui/meter"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { formatNumber } from "@maple/ui/lib/format"
import { ErrorState } from "@/components/common/error-state"
import { Panel, PanelHeader } from "@maple/ui/components/ui/panel"
import {
	Combobox,
	ComboboxContent,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
import {
	getMetricAttributeKeysResultAtom,
	getQueryBuilderBreakdownResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { MetricsQueryDraft } from "@maple/query-engine/query-builder"
import { EmptyMessage } from "@maple/ui/components/ui/empty"

const SERVICE_KEY = "service.name"
const BREAKDOWN_LIMIT = 10

/** Breakdown only supports plain aggregations — counters fall back to count. */
function breakdownAggregation(aggregation: string): "avg" | "sum" | "count" {
	if (aggregation === "avg" || aggregation === "sum" || aggregation === "count") {
		return aggregation
	}
	return "count"
}

function quoteFilterValue(value: string): string {
	return `"${value.replaceAll('"', '\\"')}"`
}

/**
 * Adds `key = "value"` to a where clause. An existing clause for the same key
 * is replaced instead of appended — the metrics path honors only a single
 * attr.* equality filter, so stacking two would silently drop the second.
 */
export function appendWhereFilter(where: string, key: string, value: string): string {
	const clause = `${key} = ${quoteFilterValue(value)}`
	const trimmed = where.trim()
	if (!trimmed) return clause

	const escapedKey = key.replaceAll(".", "\\.")
	const sameKeyClause = new RegExp(`${escapedKey}\\s*=\\s*"(?:[^"\\\\]|\\\\.)*"`)
	if (sameKeyClause.test(trimmed)) {
		return trimmed.replace(sameKeyClause, clause)
	}

	return `${trimmed} AND ${clause}`
}

interface MetricBreakdownProps {
	draft: MetricsQueryDraft
	breakdownKey: string | undefined
	startTime: string
	endTime: string
	onBreakdownKeyChange: (key: string) => void
	onAddFilter: (key: string, value: string) => void
}

/**
 * Top-N values of one attribute for the current query. Every bar is the next
 * click: selecting a bar narrows the WHERE clause to that value.
 */
export function MetricBreakdown({
	draft,
	breakdownKey,
	startTime,
	endTime,
	onBreakdownKeyChange,
	onAddFilter,
}: MetricBreakdownProps) {
	const keysResult = useAtomValue(
		getMetricAttributeKeysResultAtom({
			data: {
				startTime,
				endTime,
				metricName: draft.metricName,
				metricType: draft.metricType,
			},
		}),
	)

	const attributeKeys = Result.builder(keysResult)
		.onSuccess((r) => r.data.map((row) => row.attributeKey))
		.orElse(() => [])

	const effectiveKey = breakdownKey ?? SERVICE_KEY
	const groupBy = effectiveKey === SERVICE_KEY ? SERVICE_KEY : `attr.${effectiveKey}`

	const breakdownDraft = React.useMemo(
		(): MetricsQueryDraft => ({
			...draft,
			id: "metrics-explorer-breakdown",
			aggregation: breakdownAggregation(draft.aggregation),
			groupBy: [groupBy],
			addOns: { ...draft.addOns, groupBy: true, limit: true },
			limit: String(BREAKDOWN_LIMIT),
		}),
		[draft, groupBy],
	)

	return (
		<Panel>
			<PanelHeader
				title={`Top values · ${breakdownAggregation(draft.aggregation)} per value`}
				action={
					<Combobox
						value={effectiveKey}
						onValueChange={(value) => {
							if (value) onBreakdownKeyChange(value)
						}}
					>
						<ComboboxInput placeholder="Break down by..." className="h-7 w-52 text-xs" />
						<ComboboxContent>
							<ComboboxList>
								<ComboboxItem value={SERVICE_KEY}>{SERVICE_KEY}</ComboboxItem>
								{attributeKeys.map((key) => (
									<ComboboxItem key={key} value={key}>
										{key}
									</ComboboxItem>
								))}
							</ComboboxList>
						</ComboboxContent>
					</Combobox>
				}
			/>
			<div className="p-3">
				<BreakdownBars
					draft={breakdownDraft}
					startTime={startTime}
					endTime={endTime}
					filterKey={groupBy}
					onAddFilter={(value) => onAddFilter(groupBy, value)}
				/>
			</div>
		</Panel>
	)
}

function BreakdownBars({
	draft,
	startTime,
	endTime,
	filterKey,
	onAddFilter,
}: {
	draft: MetricsQueryDraft
	startTime: string
	endTime: string
	filterKey: string
	onAddFilter: (value: string) => void
}) {
	const result = useRefreshableAtomValue(
		getQueryBuilderBreakdownResultAtom({
			data: { startTime, endTime, queries: [draft] },
		}),
	)

	return Result.builder(result)
		.onInitial(() => <SkeletonList rows={5} rowClassName="h-6" gap="2" />)
		.onError((error) => <ErrorState error={error} title="Failed to load breakdown" variant="inline" />)
		.onSuccess((response) => {
			const rows = response.data
				.map((row) => ({
					name: String(row.name ?? ""),
					value: typeof row.value === "number" ? row.value : Number(row.value ?? 0),
				}))
				.filter((row) => row.name.length > 0)

			if (rows.length === 0) {
				return <EmptyMessage>No values for this attribute in the selected range.</EmptyMessage>
			}

			const max = Math.max(...rows.map((row) => row.value), 1)

			return (
				<div className="space-y-1">
					{rows.map((row) => (
						<button
							key={row.name}
							type="button"
							onClick={() => onAddFilter(row.name)}
							className="group relative flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1 text-left transition-colors hover:bg-accent"
						>
							<BackdropBar
								value={row.value}
								max={max}
								className="inset-y-0.5 left-0 bg-primary/10 transition-colors group-hover:bg-primary/15"
							/>
							<span className="sr-only">Filter to {filterKey} = </span>
							<TruncatedText text={row.name} mono className="relative z-10 text-xs" />
							<span className="relative z-10 shrink-0 font-mono text-xs text-muted-foreground">
								{formatNumber(row.value)}
							</span>
						</button>
					))}
				</div>
			)
		})
		.render()
}
