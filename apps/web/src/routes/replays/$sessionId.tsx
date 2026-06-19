import { createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@maple/ui/components/ui/resizable"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ReplaySurface } from "@/components/replays/replay-player"
import { ReplayPlayerProvider } from "@/components/replays/replay-player-context"
import { ReplayEditorTimeline } from "@/components/replays/replay-editor-timeline"
import { SessionEventsPanel } from "@/components/replays/session-events-panel"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getReplayEventsResultAtom,
	getReplayResultAtom,
	getSessionTranscriptResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { QueryErrorState } from "@/components/common/query-error-state"
import { ClockIcon, PulseIcon, EyeIcon, CircleWarningIcon, UserIcon, GlobeIcon } from "@/components/icons"
import { formatDuration } from "@/components/replays/replay-format"
import {
	CopyButton,
	DetailRow,
	deviceIcon,
	ReplayDetailSkeleton,
	Reveal,
	SessionIdentityHeader,
	StatTile,
} from "@/components/replays/session-detail-parts"

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

			const isActive = session.status === "active"
			const label = session.userId || "Anonymous session"

			return (
				<DashboardLayout breadcrumbs={breadcrumbs} title="Session Replay">
					<div className="flex h-full min-h-0 flex-col gap-3">
						<Reveal>
							<SessionIdentityHeader
								sessionId={sessionId}
								label={label}
								urlInitial={session.urlInitial}
								startTime={session.startTime}
								isActive={isActive}
							/>
						</Reveal>

						<ReplayPlayerProvider sessionId={sessionId}>
							{/* DevTools-style dock: the player + details + timeline scroll inside the
						    top panel; the console / network / errors panel docks below and is
						    resizable by dragging the divider. */}
							<ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
								<ResizablePanel defaultSize="60%" minSize="30%" className="min-h-0">
									<div className="h-full space-y-4 overflow-auto pr-1">
										<Reveal delay={0.06}>
											<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.9fr_1fr]">
												<ReplaySurface url={session.urlInitial} />
												<div className="space-y-4">
													{/* Activity stat tiles */}
													<div className="grid grid-cols-2 gap-2.5">
														<StatTile
															icon={<ClockIcon className="size-4" />}
															label="Duration"
															value={formatDuration(session.durationMs)}
														/>
														<StatTile
															icon={<PulseIcon className="size-4" />}
															label="Clicks"
															value={String(session.clickCount)}
														/>
														<StatTile
															icon={<EyeIcon className="size-4" />}
															label="Pages"
															value={String(session.pageViews || 1)}
														/>
														<StatTile
															icon={<CircleWarningIcon className="size-4" />}
															label="Errors"
															value={String(session.errorCount)}
															tone={
																session.errorCount > 0 ? "error" : undefined
															}
														/>
													</div>

													{/* Details */}
													<section className="overflow-hidden rounded-xl border border-border bg-card">
														<h3 className="border-b border-border px-4 py-2.5 font-display text-xs font-semibold uppercase tracking-wide text-muted-foreground">
															Details
														</h3>
														<dl className="divide-y divide-border">
															<DetailRow
																icon={<UserIcon className="size-3.5" />}
																label="User"
															>
																{session.userId || "Anonymous"}
															</DetailRow>
															<DetailRow
																icon={<GlobeIcon className="size-3.5" />}
																label="Browser"
															>
																{session.browserName || "—"}
																<span className="text-muted-foreground">
																	{session.osName
																		? ` · ${session.osName}`
																		: ""}
																</span>
															</DetailRow>
															<DetailRow
																icon={deviceIcon(session.deviceType)}
																label="Device"
															>
																<span className="capitalize">
																	{session.deviceType || "—"}
																</span>
															</DetailRow>
															<DetailRow
																icon={<GlobeIcon className="size-3.5" />}
																label="Country"
															>
																{session.country || "—"}
															</DetailRow>
															<DetailRow
																icon={<PulseIcon className="size-3.5" />}
																label="Service"
															>
																<span className="inline-flex items-center gap-1">
																	<span className="truncate font-mono text-xs">
																		{session.serviceName || "—"}
																	</span>
																	{session.serviceName && (
																		<CopyButton
																			value={session.serviceName}
																			label="Copy service name"
																		/>
																	)}
																</span>
															</DetailRow>
														</dl>
													</section>
												</div>
											</div>
										</Reveal>

										{/* Synced trace timeline — recording activity + correlated traces on a
						    shared playhead. Replaces the old flat correlated-traces list. */}
										<Reveal delay={0.12}>
											<ReplayEditorTimeline traceIds={session.traceIds} />
										</Reveal>
									</div>
								</ResizablePanel>

								<ResizableHandle
									withHandle
									className="cursor-row-resize bg-border/60 transition-colors hover:bg-primary/40 active:bg-primary/50"
								/>

								{/* Distilled console / network / error stream, clickable to seek. */}
								<ResizablePanel defaultSize="40%" minSize="15%" className="min-h-0">
									<SessionEventsPanel sessionId={sessionId} />
								</ResizablePanel>
							</ResizablePanelGroup>
						</ReplayPlayerProvider>
					</div>
				</DashboardLayout>
			)
		})
		.render()
}
