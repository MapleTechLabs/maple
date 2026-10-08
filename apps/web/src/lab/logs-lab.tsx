import { useMemo, useRef, useState } from "react"
import type { DashboardRefreshIntervalSeconds } from "@maple/domain/http"

import { Button } from "@maple/ui/components/ui/button"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { LogsLiveControls } from "@/components/logs/logs-live-controls"
import { LogsTableView, type LogsInspectState, type LogsStreamHandle } from "@/components/logs/logs-table"
import {
	PageRefreshProvider,
	usePageRefreshContext,
} from "@/components/time-range-picker/page-refresh-context"
import type { LogsDensity } from "@/hooks/use-logs-view-preferences"
import { buildLogsLabFixture } from "@/lab/logs-fixture"

/**
 * `/logs` stream without a warehouse behind it: the real `LogsTableView` over a
 * deterministic production-like fixture (HTTP access lines, slow queries, a
 * payment outage with stack traces, JSON bodies). The anchor is fixed so
 * screenshots line up across runs.
 */
const ANCHOR_MS = Date.UTC(2026, 9, 8, 14, 32, 10, 482)

const PIN_OPTIONS = ["k8s.pod.name", "user.id", "http.route"] as const

/** Newest fixture rows held back at load; each live tick reveals the next ones at the top. */
const LIVE_BACKLOG = 60
const ROWS_PER_TICK = 2

/** The live tail runs on the real refresh provider, held by the stream's inspect state. */
export function LogsLab() {
	const [refresh, setRefresh] = useState<DashboardRefreshIntervalSeconds>(0)
	const [inspect, setInspect] = useState<LogsInspectState>({ inspecting: false, scrolledAway: false })
	return (
		<PageRefreshProvider autoRefreshMs={refresh * 1000} autoRefreshPaused={inspect.inspecting}>
			<LogsLabPage
				refresh={refresh}
				onRefreshChange={setRefresh}
				inspect={inspect}
				onInspect={setInspect}
			/>
		</PageRefreshProvider>
	)
}

function LogsLabPage({
	refresh,
	onRefreshChange,
	inspect,
	onInspect,
}: {
	refresh: DashboardRefreshIntervalSeconds
	onRefreshChange: (value: DashboardRefreshIntervalSeconds) => void
	inspect: LogsInspectState
	onInspect: (state: LogsInspectState) => void
}) {
	const all = useMemo(() => buildLogsLabFixture(ANCHOR_MS), [])
	const { refreshVersion } = usePageRefreshContext()
	// Every refresh, live or manual, lands the next-newest rows on top.
	const hidden = Math.max(0, LIVE_BACKLOG - refreshVersion * ROWS_PER_TICK)
	const logs = useMemo(() => all.slice(hidden), [all, hidden])
	const streamRef = useRef<LogsStreamHandle>(null)
	const [wrap, setWrap] = useState(false)
	const [density, setDensity] = useState<LogsDensity>("compact")
	const [search, setSearch] = useState<string | undefined>(undefined)
	const [pinned, setPinned] = useState<string[]>([])
	const [empty, setEmpty] = useState(false)

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Lab" }, { label: "Logs" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							titleContent={
								<div className="flex flex-wrap items-center gap-1.5">
									<Eyebrow as="span" className="mr-1">
										Lab
									</Eyebrow>
									<Toggle label="Wrap" on={wrap} onClick={() => setWrap(!wrap)} />
									<Toggle
										label="Comfortable"
										on={density === "comfortable"}
										onClick={() =>
											setDensity(density === "compact" ? "comfortable" : "compact")
										}
									/>
									<Toggle
										label="Search “pool”"
										on={search !== undefined}
										onClick={() => setSearch(search ? undefined : "pool")}
									/>
									{PIN_OPTIONS.map((key) => (
										<Toggle
											key={key}
											label={`Pin ${key}`}
											on={pinned.includes(key)}
											onClick={() =>
												setPinned(
													pinned.includes(key)
														? pinned.filter((k) => k !== key)
														: [...pinned, key],
												)
											}
										/>
									))}
									<Toggle label="Empty" on={empty} onClick={() => setEmpty(!empty)} />
								</div>
							}
						>
							<LogsLiveControls
								value={refresh}
								onChange={onRefreshChange}
								inspect={inspect}
								onJumpToLatest={() => streamRef.current?.jumpToLatest()}
							/>
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Fill>
						<LogsTableView
							allData={empty ? [] : logs}
							isFetchingNextPage={false}
							hasNextPage={false}
							isCapped={false}
							fetchNextPage={() => {}}
							waiting={false}
							wrap={wrap}
							density={density}
							pinnedColumns={pinned}
							searchText={search}
							embedded
							onInspectingChange={onInspect}
							streamRef={streamRef}
						/>
					</DashboardLayout.Fill>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
	return (
		<Button variant={on ? "secondary" : "outline"} size="sm" aria-pressed={on} onClick={onClick}>
			{label}
		</Button>
	)
}
