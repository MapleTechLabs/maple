import { createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ReplayStudio } from "@/components/replays/replay-studio"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getReplayEventsResultAtom,
	getReplayResultAtom,
	getSessionTranscriptResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { QueryErrorState } from "@/components/common/query-error-state"
import { ReplayDetailSkeleton } from "@/components/replays/session-detail-parts"

const detailSearchSchema = Schema.Struct({
	t: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/replays/$sessionId"), ({ params }) => [
	getReplayResultAtom({ data: { sessionId: params.sessionId } }),
	getReplayEventsResultAtom({ data: { sessionId: params.sessionId } }),
	getSessionTranscriptResultAtom({ data: { sessionId: params.sessionId } }),
])({
	component: ReplayDetailPage,
	validateSearch: Schema.toStandardSchemaV1(detailSearchSchema),
})

function ReplayDetailPage() {
	const { sessionId } = Route.useParams()
	const detailResult = useAtomValue(getReplayResultAtom({ data: { sessionId } }))

	const breadcrumbs = [{ label: "Session Replays", href: "/replays" }, { label: sessionId.slice(0, 8) }]

	return Result.builder(detailResult)
		.onInitial(() => (
			<DashboardLayout breadcrumbs={breadcrumbs} title="Loading session…">
				<ReplayDetailSkeleton />
			</DashboardLayout>
		))
		.onError((error) => (
			<DashboardLayout breadcrumbs={breadcrumbs} title="Error">
				<QueryErrorState error={error} titleOverride="Failed to load session replay" />
			</DashboardLayout>
		))
		.onSuccess((detail) => {
			const session = detail.data
			if (!session) {
				return (
					<DashboardLayout
						breadcrumbs={breadcrumbs}
						title="Session not found"
						description="It may have expired or not been ingested yet."
					>
						<div className="rounded-xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
							No metadata for session <span className="font-mono">{sessionId}</span>.
						</div>
					</DashboardLayout>
				)
			}

			return (
				<DashboardLayout breadcrumbs={breadcrumbs} title="Session Replay">
					<ReplayStudio sessionId={sessionId} session={session} traceIds={session.traceIds} />
				</DashboardLayout>
			)
		})
		.render()
}
