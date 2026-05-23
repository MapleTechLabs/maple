import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

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
} from "@/lib/services/atoms/tinybird-query-atoms"
import { QueryErrorState } from "@/components/common/query-error-state"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
	GlobeIcon,
	ComputerIcon,
	ClockIcon,
	PulseIcon,
	EyeIcon,
	CircleWarningIcon,
	UserIcon,
} from "@/components/icons"
import { formatDuration, gradientFor } from "@/components/replays/replay-format"

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

	const breadcrumbs = [
		{ label: "Session Replays", href: "/replays" },
		{ label: sessionId.slice(0, 8) },
	]

	return Result.builder(detailResult)
		.onInitial(() => (
			<DashboardLayout breadcrumbs={breadcrumbs} title="Loading session…">
				<Skeleton className="h-[60vh] w-full rounded-xl" />
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
					{/* Identity header */}
					<div className="mb-5 flex flex-wrap items-center gap-3">
						<div
							className={`grid size-11 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(sessionId)} text-base font-semibold text-white shadow-sm`}
						>
							{(label[0] ?? "?").toUpperCase()}
						</div>
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<h2 className="truncate text-lg font-semibold leading-tight">{label}</h2>
								<StatusPill active={isActive} />
							</div>
							<a
								href={session.urlInitial}
								target="_blank"
								rel="noreferrer"
								className="inline-flex max-w-md items-center gap-1.5 truncate font-mono text-xs text-muted-foreground hover:text-foreground"
							>
								<GlobeIcon className="size-3 shrink-0 opacity-70" />
								<span className="truncate">{session.urlInitial}</span>
							</a>
						</div>
					</div>

					<ReplayPlayerProvider sessionId={sessionId}>
						{/* Content-sized split: player + details flow with the page (one outer
						    scroll), so neither panel gets its own scrollbar. */}
						<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.9fr_1fr]">
							<ReplaySurface url={session.urlInitial} />
							<div className="space-y-5">
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
										tone={session.errorCount > 0 ? "error" : undefined}
									/>
								</div>

								{/* Details */}
								<section className="rounded-xl border border-border">
									<h3 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
										Details
									</h3>
									<dl className="divide-y divide-border">
										<DetailRow icon={<UserIcon className="size-3.5" />} label="User">
											{session.userId || "Anonymous"}
										</DetailRow>
										<DetailRow icon={<ComputerIcon className="size-3.5" />} label="Browser">
											{session.browserName || "—"}
											<span className="text-muted-foreground">
												{session.osName ? ` · ${session.osName}` : ""}
											</span>
										</DetailRow>
										<DetailRow icon={<ComputerIcon className="size-3.5" />} label="Device">
											<span className="capitalize">{session.deviceType || "—"}</span>
										</DetailRow>
										<DetailRow icon={<GlobeIcon className="size-3.5" />} label="Country">
											{session.country || "—"}
										</DetailRow>
										<DetailRow icon={<PulseIcon className="size-3.5" />} label="Service">
											<span className="font-mono text-xs">{session.serviceName || "—"}</span>
										</DetailRow>
									</dl>
								</section>
							</div>
						</div>

						{/* Synced trace timeline — recording activity + correlated traces on a
						    shared playhead. Replaces the old flat correlated-traces list. */}
						<div className="mt-4">
							<ReplayEditorTimeline traceIds={session.traceIds} />
						</div>

						{/* Distilled console / network / error stream, clickable to seek. */}
						<div className="mt-4">
							<SessionEventsPanel sessionId={sessionId} />
						</div>
					</ReplayPlayerProvider>
				</DashboardLayout>
			)
		})
		.render()
}

function StatusPill({ active }: { active: boolean }) {
	if (!active) {
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
				<span className="size-1.5 rounded-full bg-muted-foreground/50" />
				Ended
			</span>
		)
	}
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
			<span className="relative flex size-1.5">
				<span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
				<span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
			</span>
			Live
		</span>
	)
}

function StatTile({
	icon,
	label,
	value,
	tone,
}: {
	icon: React.ReactNode
	label: string
	value: string
	tone?: "error"
}) {
	return (
		<div className="rounded-xl border border-border p-3">
			<div
				className={`mb-1.5 flex items-center gap-1.5 text-xs font-medium ${
					tone === "error" ? "text-destructive" : "text-muted-foreground"
				}`}
			>
				<span className="opacity-80">{icon}</span>
				{label}
			</div>
			<div
				className={`text-xl font-semibold tabular-nums ${
					tone === "error" ? "text-destructive" : ""
				}`}
			>
				{value}
			</div>
		</div>
	)
}

function DetailRow({
	icon,
	label,
	children,
}: {
	icon: React.ReactNode
	label: string
	children: React.ReactNode
}) {
	return (
		<div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
			<dt className="flex items-center gap-2 text-muted-foreground">
				<span className="opacity-70">{icon}</span>
				{label}
			</dt>
			<dd className="truncate text-right font-medium">{children}</dd>
		</div>
	)
}

