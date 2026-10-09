import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { Button } from "@maple/ui/components/ui/button"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { countLabel } from "@maple/ui/lib/format"

import { DashboardPage } from "@/components/layout/dashboard-page"
import { PlusIcon } from "@/components/icons"
import { InstallHostModal } from "@/components/infra/install-modal"
import {
	NeedsAttention,
	SOURCE_ORDER,
	SOURCE_TITLE,
	SourcesTable,
	presentSources,
} from "@/components/infra/overview/infra-overview"
import { PageHero } from "@/components/common/page-hero"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useInfraSurfaces } from "@/hooks/use-infra-surfaces"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import type { TimeRange } from "@/components/time-range-picker/types"

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

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Infrastructure" }]}
			time={{ search, startTime, endTime, defaultPreset: DEFAULT_PRESET, onChange: handleTimeChange }}
		>
			<div className="space-y-10">
				<PageHero
					title="Infrastructure"
					description={
						sources.length > 0
							? `${countLabel(sources.length, "source")} reporting. What needs a look comes first.`
							: "Nothing is reporting yet. Install a collector or connect a provider to get started."
					}
				/>

				{sources.length > 0 ? (
					<>
						<NeedsAttention sources={sources} window={window} timeSearch={timeSearch} />
						<SourcesTable sources={sources} window={window} timeSearch={timeSearch} />
					</>
				) : null}

				{missing.length > 0 ? (
					<EmptyMessage dashed className="flex flex-wrap items-center gap-4 px-4 py-4 text-left">
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="text-sm text-foreground">Add a source</span>
							<span className="text-xs text-muted-foreground">
								Not reporting yet: {missing.map((id) => SOURCE_TITLE[id]).join(", ")}.
							</span>
						</div>
						<Button size="sm" variant="outline" onClick={() => setInstallOpen(true)}>
							<PlusIcon />
							Install a collector
						</Button>
						<Button size="sm" render={<Link to="/integrations" />}>
							Connect a provider
						</Button>
					</EmptyMessage>
				) : null}
			</div>

			<InstallHostModal open={installOpen} onOpenChange={setInstallOpen} defaultTab="hosts" />
		</DashboardPage>
	)
}
