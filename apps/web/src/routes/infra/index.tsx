import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { Button } from "@maple/ui/components/ui/button"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PlusIcon } from "@/components/icons"
import { InstallHostModal } from "@/components/infra/install-modal"
import {
	NeedsAttention,
	SOURCE_ORDER,
	SOURCE_TITLE,
	SourcesTable,
	presentSources,
} from "@/components/infra/overview/infra-overview"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useInfraSurfaces } from "@/hooks/use-infra-surfaces"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const DEFAULT_PRESET = "1h"

const overviewSearchSchema = Schema.Struct({
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/infra/")({
	component: InfraOverviewPage,
	validateSearch: Schema.toStandardSchemaV1(overviewSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

function InfraOverviewPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const [installOpen, setInstallOpen] = useState(false)

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const window = { startTime, endTime }
	const timeSearch = pickTimeRangeSearch(search)

	const surfaces = useInfraSurfaces(window)
	const sources = presentSources(surfaces)
	const missing = SOURCE_ORDER.filter((id) => !sources.includes(id))

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? DEFAULT_PRESET}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Infrastructure" }]} />
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
							<div className="space-y-10">
								<PageHero
									title="Infrastructure"
									description={
										sources.length > 0
											? `${sources.length} ${sources.length === 1 ? "source" : "sources"} reporting. What needs a look comes first.`
											: "Nothing is reporting yet. Install a collector or connect a provider to get started."
									}
								/>

								{sources.length > 0 ? (
									<>
										<NeedsAttention
											sources={sources}
											window={window}
											timeSearch={timeSearch}
										/>
										<SourcesTable
											sources={sources}
											window={window}
											timeSearch={timeSearch}
										/>
									</>
								) : null}

								{missing.length > 0 ? (
									<div className="flex flex-wrap items-center gap-4 rounded-lg border border-dashed px-4 py-4">
										<div className="flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="text-sm text-foreground">Add a source</span>
											<span className="text-xs text-muted-foreground">
												Not reporting yet:{" "}
												{missing.map((id) => SOURCE_TITLE[id]).join(", ")}.
											</span>
										</div>
										<Button
											size="sm"
											variant="outline"
											onClick={() => setInstallOpen(true)}
										>
											<PlusIcon size={14} />
											Install a collector
										</Button>
										<Button size="sm" render={<Link to="/integrations" />}>
											Connect a provider
										</Button>
									</div>
								) : null}
							</div>

							<InstallHostModal
								open={installOpen}
								onOpenChange={setInstallOpen}
								defaultTab="hosts"
							/>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
