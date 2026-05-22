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
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@maple/ui/components/ui/resizable"
import {
	GlobeIcon,
	ComputerIcon,
	ClockIcon,
	PulseIcon,
	EyeIcon,
	CircleWarningIcon,
	UserIcon,
	ArrowRightIcon,
} from "@/components/icons"

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

const AVATAR_GRADIENTS = [
	"from-rose-500/80 to-orange-400/80",
	"from-violet-500/80 to-fuchsia-400/80",
	"from-sky-500/80 to-cyan-400/80",
	"from-emerald-500/80 to-teal-400/80",
	"from-amber-500/80 to-yellow-400/80",
	"from-indigo-500/80 to-blue-400/80",
]
function gradientFor(seed: string): string {
	let hash = 0
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
	return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length]!
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

			const chunks = Result.builder(eventsResult)
				.onSuccess((e) => e.chunks as ReadonlyArray<ReplayChunkUrl>)
				.orElse(() => [] as ReadonlyArray<ReplayChunkUrl>)

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

					<ResizablePanelGroup orientation="horizontal" className="min-h-[70vh] gap-4">
						<ResizablePanel defaultSize={66} minSize={45}>
							<ReplayPlayer chunks={chunks} url={session.urlInitial} />
						</ResizablePanel>
						<ResizableHandle withHandle />
						<ResizablePanel defaultSize={34} minSize={26}>
							<div className="space-y-5 pl-1">
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

								{/* Correlated traces */}
								<CorrelatedTraces traceIds={session.traceIds} />
							</div>
						</ResizablePanel>
					</ResizablePanelGroup>
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

function CorrelatedTraces({ traceIds }: { traceIds: ReadonlyArray<string> }) {
	return (
		<section className="rounded-xl border border-border">
			<h3 className="flex items-center justify-between border-b border-border px-4 py-2.5">
				<span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					<PulseIcon className="size-3.5" />
					Correlated traces
				</span>
				{traceIds.length > 0 && (
					<span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium tabular-nums text-primary">
						{traceIds.length}
					</span>
				)}
			</h3>
			{traceIds.length === 0 ? (
				<p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
					No backend traces were linked to this session. Correlation populates automatically
					when the page is instrumented with <span className="font-mono">@maple/browser</span>{" "}
					tracing — every request made during the session is stitched to its trace here.
				</p>
			) : (
				<ul className="divide-y divide-border">
					{traceIds.map((traceId) => (
						<li key={traceId}>
							<Link
								to="/traces/$traceId"
								params={{ traceId }}
								className="group flex items-center justify-between gap-2 px-4 py-2.5 transition-colors hover:bg-muted/50"
							>
								<span className="truncate font-mono text-xs text-foreground">
									{traceId.slice(0, 18)}…
								</span>
								<ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
							</Link>
						</li>
					))}
				</ul>
			)}
		</section>
	)
}
