import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result, useAtomValue, useAtomRefresh } from "@/lib/effect-atom"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ErrorState } from "@/components/common/error-state"
import { HostDetailHeader, HostDetailHeaderLoading } from "@/components/infra/host-detail-header"
import { MetricStrip } from "@/components/infra/host-detail-chart"
import { HostMetadataPanel } from "@/components/infra/host-metadata-panel"
import { hostDetailSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { bucketSecondsForRange } from "@/components/infra/constants"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useLinkedCursor } from "@/hooks/use-linked-cursor"
import {
	TimeRangeSearchFields,
	WIDEN_TIME_PRESET,
	applyTimeRangeSearch,
	canWidenTimeRange,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

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

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
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

	const rightSidebar = <HostMetadataPanel summary={summary} />

	// Linked hover cursor across the metric strips (charts stay independent —
	// no Recharts syncId render storms).
	const { containerProps: linkedCursorContainerProps } = useLinkedCursor(true)

	return (
		<PageRefreshProvider timePreset={preset}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[
						{ label: "Infrastructure", href: "/infra" },
						{ label: "Hosts", href: "/infra/hosts" },
						{ label: hostName },
					]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header>
								<TimeRangeHeaderControls
									startTime={search.startTime ?? startTime}
									endTime={search.endTime ?? endTime}
									presetValue={
										search.timePreset ?? (search.startTime ? undefined : DEFAULT_PRESET)
									}
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-8">
								{Result.builder(summaryResult)
									.onInitial(() => <HostDetailHeaderLoading />)
									.onError((error) => (
										<ErrorState
											variant="inline"
											error={error}
											title="Failed to load host summary"
											onRetry={refreshSummary}
										/>
									))
									.onSuccess((r) => (
										<HostDetailHeader
											summary={r.data}
											hostName={hostName}
											onWidenRange={
												canWidenTimeRange(search, DEFAULT_PRESET)
													? () =>
															handleTimeChange({
																presetValue: WIDEN_TIME_PRESET,
															})
													: undefined
											}
										/>
									))
									.render()}

								<div className="rounded-md border bg-card">
									<div className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5">
										<span className="text-sm font-medium">Metrics</span>
										<span className="text-xs tabular-nums text-muted-foreground">
											{METRIC_STRIPS.length} signals
										</span>
									</div>
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
								</div>
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
					<DashboardLayout.RightPanel>{rightSidebar}</DashboardLayout.RightPanel>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
