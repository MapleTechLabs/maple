import { createFileRoute } from "@tanstack/react-router"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ReplaySurface } from "@/components/replays/replay-player"
import { ReplayPlayerProvider } from "@/components/replays/replay-player-context"
import { ReplayEditorTimeline } from "@/components/replays/replay-editor-timeline"
import { SessionEventsPanel } from "@/components/replays/session-events-panel"
import {
	ClockIcon,
	PulseIcon,
	EyeIcon,
	CircleWarningIcon,
	UserIcon,
	GlobeIcon,
} from "@/components/icons"
import { formatDuration } from "@/components/replays/replay-format"
import {
	CopyButton,
	DetailRow,
	deviceIcon,
	Reveal,
	SessionIdentityHeader,
	StatTile,
} from "@/components/replays/session-detail-parts"
import {
	PREVIEW_RRWEB_EVENTS,
	PREVIEW_SESSION,
	PREVIEW_TRACE_SUMMARIES,
	PREVIEW_TRANSCRIPT,
} from "@/components/replays/preview-fixtures"

// TEMPORARY preview route: renders the session-replay detail page against
// hand-built placeholder data (no warehouse needed) so the polished UI can be
// reviewed end-to-end. Delete this file + preview-fixtures.ts when done.
export const Route = createFileRoute("/replays/preview")({
	component: ReplayPreviewPage,
})

function ReplayPreviewPage() {
	const session = PREVIEW_SESSION
	const breadcrumbs = [
		{ label: "Session Replays", href: "/replays" },
		{ label: "Preview" },
	]

	return (
		<DashboardLayout breadcrumbs={breadcrumbs} title="Session Replay (preview)">
			<Reveal>
				<SessionIdentityHeader
					sessionId={session.sessionId}
					label={session.userId}
					urlInitial={session.urlInitial}
					startTime={session.startTime}
					isActive={false}
				/>
			</Reveal>

			<ReplayPlayerProvider sessionId={session.sessionId} previewEvents={PREVIEW_RRWEB_EVENTS}>
				<Reveal delay={0.06}>
					<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.9fr_1fr]">
						<ReplaySurface url={session.urlInitial} />
						<div className="space-y-4">
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
									value={String(session.pageViews)}
								/>
								<StatTile
									icon={<CircleWarningIcon className="size-4" />}
									label="Errors"
									value={String(session.errorCount)}
									tone={session.errorCount > 0 ? "error" : undefined}
								/>
							</div>

							<section className="overflow-hidden rounded-xl border border-border bg-card">
								<h3 className="border-b border-border px-4 py-2.5 font-display text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Details
								</h3>
								<dl className="divide-y divide-border">
									<DetailRow icon={<UserIcon className="size-3.5" />} label="User">
										{session.userId}
									</DetailRow>
									<DetailRow icon={<GlobeIcon className="size-3.5" />} label="Browser">
										{session.browserName}
										<span className="text-muted-foreground">{` · ${session.osName}`}</span>
									</DetailRow>
									<DetailRow icon={deviceIcon(session.deviceType)} label="Device">
										<span className="capitalize">{session.deviceType}</span>
									</DetailRow>
									<DetailRow icon={<GlobeIcon className="size-3.5" />} label="Country">
										{session.country}
									</DetailRow>
									<DetailRow icon={<PulseIcon className="size-3.5" />} label="Service">
										<span className="inline-flex items-center gap-1">
											<span className="truncate font-mono text-xs">{session.serviceName}</span>
											<CopyButton value={session.serviceName} label="Copy service name" />
										</span>
									</DetailRow>
								</dl>
							</section>
						</div>
					</div>
				</Reveal>

				<Reveal delay={0.12}>
					<div className="mt-4">
						<ReplayEditorTimeline traceIds={[]} previewSummaries={PREVIEW_TRACE_SUMMARIES} />
					</div>
				</Reveal>

				<Reveal delay={0.18}>
					<div className="mt-4">
						<SessionEventsPanel sessionId={session.sessionId} previewEvents={PREVIEW_TRANSCRIPT} />
					</div>
				</Reveal>
			</ReplayPlayerProvider>
		</DashboardLayout>
	)
}
