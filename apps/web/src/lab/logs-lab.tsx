import { useMemo, useState } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { LogContextFixtureProvider } from "@/components/logs/log-context-panel"
import { LogsTableView } from "@/components/logs/logs-table"
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

export function LogsLab() {
	const logs = useMemo(() => buildLogsLabFixture(ANCHOR_MS), [])
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
						<DashboardLayout.Header>
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
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Fill>
						<LogContextFixtureProvider logs={logs}>
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
							/>
						</LogContextFixtureProvider>
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
