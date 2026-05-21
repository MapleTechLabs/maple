import * as React from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ReplayPlayer, type ReplayChunkUrl } from "@/components/replays/replay-player"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getReplayEventsResultAtom,
	getReplayResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { QueryErrorState } from "@/components/common/query-error-state"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Badge } from "@maple/ui/components/ui/badge"
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@maple/ui/components/ui/resizable"

const detailSearchSchema = Schema.Struct({
	t: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/replays/$sessionId"), ({ params }) => [
	getReplayResultAtom({ data: { sessionId: params.sessionId } }),
	getReplayEventsResultAtom({ data: { sessionId: params.sessionId } }),
])({
	component: ReplayDetailPage,
	validateSearch: Schema.toStandardSchemaV1(detailSearchSchema),
})

function formatDuration(ms: number | null): string {
	if (ms == null || ms <= 0) return "—"
	const seconds = Math.round(ms / 1000)
	const minutes = Math.floor(seconds / 60)
	return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function ReplayDetailPage() {
	const { sessionId } = Route.useParams()
	const detailResult = useAtomValue(getReplayResultAtom({ data: { sessionId } }))
	const eventsResult = useAtomValue(getReplayEventsResultAtom({ data: { sessionId } }))

	const breadcrumbs = [
		{ label: "Session Replays", href: "/replays" },
		{ label: sessionId.slice(0, 8) },
	]

	return Result.builder(detailResult)
		.onInitial(() => (
			<DashboardLayout breadcrumbs={breadcrumbs} title="Loading session…">
				<Skeleton className="h-[60vh] w-full" />
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
						description="This session could not be found. It may have expired or not been ingested yet."
					>
						<div className="rounded-md border border-dashed p-12 text-center text-sm text-muted-foreground">
							No metadata for session <span className="font-mono">{sessionId}</span>.
						</div>
					</DashboardLayout>
				)
			}

			const chunks = Result.builder(eventsResult)
				.onSuccess((e) => e.chunks as ReadonlyArray<ReplayChunkUrl>)
				.orElse(() => [] as ReadonlyArray<ReplayChunkUrl>)

			return (
				<DashboardLayout
					breadcrumbs={breadcrumbs}
					title={session.userId || "Anonymous session"}
					description={session.urlInitial}
				>
					<ResizablePanelGroup orientation="horizontal" className="min-h-[70vh]">
						<ResizablePanel defaultSize={65} minSize={40}>
							<div className="pr-3">
								<ReplayPlayer chunks={chunks} />
							</div>
						</ResizablePanel>
						<ResizableHandle withHandle />
						<ResizablePanel defaultSize={35} minSize={25}>
							<div className="space-y-6 pl-3">
								<section>
									<h3 className="mb-2 text-sm font-medium">Session</h3>
									<dl className="space-y-1.5 text-sm">
										<Row label="Status">
											<Badge variant={session.status === "ended" ? "secondary" : "default"}>
												{session.status}
											</Badge>
										</Row>
										<Row label="Duration">{formatDuration(session.durationMs)}</Row>
										<Row label="Browser">{`${session.browserName} · ${session.osName}`}</Row>
										<Row label="Device">{session.deviceType || "—"}</Row>
										<Row label="Country">{session.country || "—"}</Row>
										<Row label="Service">{session.serviceName || "—"}</Row>
										<Row label="Pages">{session.pageViews}</Row>
										<Row label="Clicks">{session.clickCount}</Row>
										<Row label="Errors">{session.errorCount}</Row>
									</dl>
								</section>

								<section>
									<h3 className="mb-2 text-sm font-medium">Correlated traces</h3>
									{session.traceIds.length === 0 ? (
										<p className="text-sm text-muted-foreground">
											No traces were observed during this session.
										</p>
									) : (
										<ul className="space-y-1">
											{session.traceIds.map((traceId) => (
												<li key={traceId}>
													<Link
														to="/traces/$traceId"
														params={{ traceId }}
														className="font-mono text-xs text-primary hover:underline"
													>
														{traceId.slice(0, 16)}…
													</Link>
												</li>
											))}
										</ul>
									)}
								</section>
							</div>
						</ResizablePanel>
					</ResizablePanelGroup>
				</DashboardLayout>
			)
		})
		.render()
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="text-right">{children}</dd>
		</div>
	)
}
