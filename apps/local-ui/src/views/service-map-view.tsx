import { useMemo } from "react"
import { CircleInfoIcon } from "@maple/ui/components/icons"
import { cn } from "@maple/ui/lib/utils"
import {
	ServiceMapFlowCanvas,
	type ServiceMapDetailPanelContext,
} from "@maple/ui/components/service-map/service-map-canvas"
import { ServiceMapLoading } from "@maple/ui/components/service-map/service-map-loading"
import {
	buildFlowElements,
	DB_NODE_PREFIX,
	parseDbNodeId,
} from "@maple/ui/components/service-map/service-map-utils"
import { useLocalServiceMap, type LocalServiceMapData } from "../hooks/use-local-service-map"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { resolveRange, WIDEST_RANGE } from "../lib/time"
import { useServiceMapLayout, useServiceMapViewPrefs } from "../lib/service-map-state"
import { ServiceMapDatabasePanel, ServiceMapServicePanel } from "../components/service-map-panel"
import { SignalEmptyState } from "../components/signal-empty-state"
import { RefreshButton, TimeRangeSelect, Toolbar, ToolbarStat, ToolbarStats } from "../components/toolbar"
import { ErrorState } from "../components/view-states"

function buildGraph(data: LocalServiceMapData, durationSeconds: number) {
	const { nodes, edges } = buildFlowElements({
		edges: data.edges,
		dbEdges: data.dbEdges,
		serviceOverviews: data.overviews,
		durationSeconds,
		platforms: data.platforms,
		runtimes: data.runtimes,
	})
	// Focus targets and the legend list real services only, not synthetic db: nodes.
	const services = Array.from(
		new Set(nodes.filter((n) => !n.id.startsWith(DB_NODE_PREFIX)).map((n) => n.id)),
	).toSorted()
	return { nodes, edges, services }
}

/** Services are on the map but none called another: say what draws an edge. */
function NoEdgesNotice() {
	return (
		<div className="flex shrink-0 items-start gap-2 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
			<CircleInfoIcon size={14} className="mt-px shrink-0" />
			<p>
				No service-to-service calls in this window. An edge appears when a{" "}
				<span className="font-medium text-foreground">Client</span> (or Producer) span in one service
				has a <span className="font-medium text-foreground">Server</span> (or Consumer) child span in
				another, so both services need tracing and must propagate trace context between them. Database
				calls show up from client spans that carry{" "}
				<code className="rounded bg-muted px-1 font-mono">db.system.name</code>.
			</p>
		</div>
	)
}

export function ServiceMapView() {
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	// The window's logical length: rates divide by it, not by the clock-skew pad on the bounds.
	const durationSeconds = resolveRange(range).minutes * 60
	const map = useLocalServiceMap(timeWindow.bounds, durationSeconds)
	const [layout, setLayout] = useServiceMapLayout()
	const [viewPrefs, setViewPrefs] = useServiceMapViewPrefs()
	const data = map.data

	const graph = useMemo(() => (data ? buildGraph(data, durationSeconds) : null), [data, durationSeconds])
	const databaseCount = graph ? graph.nodes.length - graph.services.length : 0

	const renderDetailPanel = ({ selectedId, colorMode, onClose, onFocus }: ServiceMapDetailPanelContext) => {
		if (!data) return null
		if (selectedId.startsWith(DB_NODE_PREFIX)) {
			const { dbSystem, dbNamespace } = parseDbNodeId(selectedId)
			return (
				<ServiceMapDatabasePanel
					dbSystem={dbSystem}
					dbNamespace={dbNamespace}
					dbEdges={data.dbEdges}
					durationSeconds={durationSeconds}
					range={range}
					onClose={onClose}
				/>
			)
		}
		return (
			<ServiceMapServicePanel
				serviceName={selectedId}
				overviews={data.overviews}
				edges={data.edges}
				dbEdges={data.dbEdges}
				platform={data.platforms.get(selectedId)}
				colorMode={colorMode}
				durationSeconds={durationSeconds}
				range={range}
				onFocus={onFocus}
				onClose={onClose}
			/>
		)
	}

	return (
		<div className="flex h-full flex-col">
			<Toolbar>
				<ToolbarStats>
					<ToolbarStat value={graph?.services.length ?? 0} label="services" />
					<ToolbarStat value={data?.edges.length ?? 0} label="connections" />
					<ToolbarStat value={databaseCount} label="databases" />
				</ToolbarStats>
				<ToolbarStats>
					<RefreshButton advance={timeWindow.advance} since={map.dataUpdatedAt} />
					<TimeRangeSelect value={range} onChange={setRange} />
				</ToolbarStats>
			</Toolbar>

			{data && data.overviews.length > 0 && data.edges.length === 0 ? <NoEdgesNotice /> : null}

			<div className={cn("min-h-0 flex-1", map.isPlaceholderData && "opacity-60 transition-opacity")}>
				{map.isPending ? (
					<ServiceMapLoading />
				) : map.isError ? (
					<ErrorState label="the service map" error={map.error} onRetry={() => map.refetch()} />
				) : graph ? (
					<ServiceMapFlowCanvas
						nodes={graph.nodes}
						edges={graph.edges}
						services={graph.services}
						layout={layout}
						onLayoutChange={setLayout}
						viewPrefs={viewPrefs}
						onViewPrefsChange={setViewPrefs}
						emptyState={
							<SignalEmptyState
								signal="traces"
								noun="services"
								range={range}
								onWidenRange={() => setRange(WIDEST_RANGE)}
							/>
						}
						renderDetailPanel={renderDetailPanel}
						showLayoutDebug={import.meta.env.DEV}
					/>
				) : null}
			</div>
		</div>
	)
}
