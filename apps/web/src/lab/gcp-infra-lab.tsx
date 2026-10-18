import { useMemo, useState } from "react"

import { DashboardPage } from "@/components/layout/dashboard-page"
import { GcpListPage, type GcpListState } from "@/components/infra/gcp/gcp-list-page"
import { gcpSparks } from "@/components/infra/gcp/list-model"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import {
	BUCKET_SECONDS,
	CLOUD_SQL_INSTANCES,
	END,
	FLEET,
	PROJECT_HEALTH,
	SPARKLINE_READS,
	START,
	VIEW_LABEL,
	VIEWS,
} from "./gcp-infra-fixture"

/** The redesigned Google Cloud list, whole, over fixtures that reproduce the Paper artboards. */
export function GcpInfraLab() {
	const [state, setState] = useState<GcpListState>({ view: "services" })
	const sparks = useMemo(
		() => gcpSparks(SPARKLINE_READS, { startTime: START, endTime: END, bucketSeconds: BUCKET_SECONDS }),
		[],
	)
	return (
		<>
			<div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-popover px-3 py-2 shadow-lg">
				<span className="font-mono text-2xs text-muted-foreground">Google Cloud lab</span>
				<SegmentPivot<(typeof VIEWS)[number]>
					ariaLabel="Lab view"
					options={VIEWS.map((value) => ({ value, label: VIEW_LABEL[value] }))}
					value={VIEWS.find((view) => view === state.view) ?? "services"}
					onChange={(view) => setState({ view })}
				/>
			</div>
			<DashboardPage breadcrumbs={[{ label: "Infrastructure" }, { label: "Google Cloud" }]} gap="lg">
				<GcpListPage
					fleet={FLEET}
					sparks={sparks}
					cloudSqlInstances={CLOUD_SQL_INSTANCES}
					projectHealth={PROJECT_HEALTH}
					collecting={false}
					state={state}
					onStateChange={(patch) => setState((prev) => ({ ...prev, ...patch }))}
					timeSearch={{ startTime: START, endTime: END }}
				/>
			</DashboardPage>
		</>
	)
}
