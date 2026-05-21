import { createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { SessionsTable, type SessionRow } from "@/components/replays/sessions-table"
import { BooleanFromStringParam } from "@/lib/search-params"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { listReplaysResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { QueryErrorState } from "@/components/common/query-error-state"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

const replaysSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
	service: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	q: Schema.optional(Schema.String),
})

export type ReplaysSearchParams = Schema.Schema.Type<typeof replaysSearchSchema>

export const Route = effectRoute(createFileRoute("/replays/"))({
	component: ReplaysPage,
	validateSearch: Schema.toStandardSchemaV1(replaysSearchSchema),
})

function ReplaysPage() {
	const search = Route.useSearch()
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "24h",
	)

	const result = useAtomValue(
		listReplaysResultAtom({
			data: {
				startTime,
				endTime,
				serviceName: search.service,
				browser: search.browser,
				country: search.country,
				deviceType: search.deviceType,
				hasErrors: search.hasErrors,
				search: search.q,
			},
		}),
	)

	const breadcrumbs = [{ label: "Session Replays" }]

	return Result.builder(result)
		.onInitial(() => (
			<DashboardLayout
				breadcrumbs={breadcrumbs}
				title="Session Replays"
				description="Watch what your users actually saw and did in the browser."
			>
				<div className="space-y-2">
					{Array.from({ length: 6 }).map((_, i) => (
						<Skeleton key={i} className="h-12 w-full" />
					))}
				</div>
			</DashboardLayout>
		))
		.onError((error) => (
			<DashboardLayout
				breadcrumbs={breadcrumbs}
				title="Session Replays"
				description="Watch what your users actually saw and did in the browser."
			>
				<QueryErrorState error={error} titleOverride="Failed to load session replays" />
			</DashboardLayout>
		))
		.onSuccess((data) => (
			<DashboardLayout
				breadcrumbs={breadcrumbs}
				title="Session Replays"
				description="Watch what your users actually saw and did in the browser."
			>
				<SessionsTable sessions={data.data as ReadonlyArray<SessionRow>} />
			</DashboardLayout>
		))
		.render()
}
