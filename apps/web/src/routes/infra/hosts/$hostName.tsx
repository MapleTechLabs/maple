import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ResultView } from "@/components/common/result-view"
import { Schema } from "effect"
import { Panel, PanelHeader } from "@maple/ui/components/ui/panel"
import { countLabel } from "@maple/ui/lib/format"
import { Result, useAtomValue, useAtomRefresh } from "@/lib/effect-atom"

import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import { ErrorState } from "@/components/common/error-state"
import { HostDetailHeader, HostDetailHeaderLoading } from "@/components/infra/host-detail-header"
import { MetricStrip } from "@/components/infra/host-detail-chart"
import { HostMetadataPanel } from "@/components/infra/host-metadata-panel"
import { hostDetailSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { bucketSecondsForRange } from "@/components/infra/constants"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useLinkedCursor } from "@/hooks/use-linked-cursor"
import { ServerIcon } from "@/components/icons"
import { ResourceAttributesCardSkeleton } from "@/components/infra/primitives/resource-attributes-card"
import {
	TimeRangeSearchFields,
	WIDEN_TIME_PRESET,
	applyTimeRangeSearch,
	canWidenTimeRange,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"

const DEFAULT_PRESET = "1h"

const hostDetailSearchSchema = Schema.Struct({
	...TimeRangeSearchFields,
})

// The window lives in the URL so a link from the overview or the list opens
// the range it was found in, not the default hour.
export const Route = createFileRoute("/infra/hosts/$hostName")({
	component: HostDetailPage,
	validateSearch: Schema.toStandardSchemaV1(hostDetailSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const METRIC_STRIPS = [
	{ metric: "cpu", label: "CPU", caption: "Per-mode utilization · stacked area" },
	{ metric: "memory", label: "Memory", caption: "Used / cached / free · stacked" },
	{ metric: "filesystem", label: "Filesystem", caption: "Mountpoint utilization" },
	{ metric: "network", label: "Network", caption: "Throughput in/out per device" },
	{ metric: "load15", label: "Load 15m", caption: "Linux load average" },
] as const

function HostDetailPage() {
	const { hostName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const preset = search.timePreset ?? DEFAULT_PRESET

	const { startTime, endTime } = useEffectiveTimeRange(search.startTime, search.endTime, preset)
	const bucketSeconds = bucketSecondsForRange(startTime, endTime)

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	const summaryAtom = hostDetailSummaryResultAtom({
		data: { hostName, startTime, endTime },
	})
	const summaryResult = useAtomValue(summaryAtom)
	const refreshSummary = useAtomRefresh(summaryAtom)

	const summary = Result.builder(summaryResult)
		.onSuccess((r) => r.data)
		.orElse(() => null)

	const rightSidebar = summary ? (
		<HostMetadataPanel summary={summary} />
	) : Result.isInitial(summaryResult) ? (
		<ResourceAttributesCardSkeleton icon={ServerIcon} />
	) : null

	// Linked hover cursor across the metric strips (charts stay independent —
	// no Recharts syncId render storms).
	const { containerProps: linkedCursorContainerProps } = useLinkedCursor(true)

	return (
		<DashboardPage
			breadcrumbs={[
				{ label: "Infrastructure", href: "/infra" },
				{ label: "Hosts", href: "/infra/hosts" },
				{ label: hostName },
			]}
			time={{ search, startTime, endTime, defaultPreset: DEFAULT_PRESET, onChange: handleTimeChange }}
			rightPanel={rightSidebar}
		>
			<div className="space-y-8">
				<ResultView
					result={summaryResult}
					loading={<HostDetailHeaderLoading />}
					error={(error) => (
						<ErrorState
							variant="inline"
							error={error}
							title="Failed to load host summary"
							onRetry={refreshSummary}
						/>
					)}
				>
					{(r) => (
						<HostDetailHeader
							summary={r.data}
							hostName={hostName}
							onWidenRange={
								canWidenTimeRange(search, DEFAULT_PRESET)
									? () => handleTimeChange({ presetValue: WIDEN_TIME_PRESET })
									: undefined
							}
						/>
					)}
				</ResultView>

				<Panel className="overflow-visible">
					<PanelHeader
						title="Metrics"
						action={
							<span className="text-xs tabular-nums text-muted-foreground">
								{countLabel(METRIC_STRIPS.length, "signal")}
							</span>
						}
					/>
					<div className="px-4" {...linkedCursorContainerProps}>
						{METRIC_STRIPS.map((strip) => (
							<MetricStrip
								key={strip.metric}
								label={strip.label}
								caption={strip.caption}
								hostName={hostName}
								metric={strip.metric}
								startTime={startTime}
								endTime={endTime}
								bucketSeconds={bucketSeconds}
								syncId={`host-${hostName}`}
							/>
						))}
					</div>
				</Panel>
			</div>
		</DashboardPage>
	)
}
