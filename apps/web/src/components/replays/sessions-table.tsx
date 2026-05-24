import { useNavigate } from "@tanstack/react-router"
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@maple/ui/components/ui/table"
import {
	GlobeIcon,
	ComputerIcon,
	ClockIcon,
	PulseIcon,
	CircleWarningIcon,
	EyeIcon,
} from "@/components/icons"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { formatDuration, gradientFor, hostFromUrl } from "./replay-format"

export interface SessionRow {
	readonly sessionId: string
	readonly startTime: string
	readonly durationMs: number | null
	readonly status: string
	readonly userId: string
	readonly urlInitial: string
	readonly browserName: string
	readonly osName: string
	readonly deviceType: string
	readonly country: string
	readonly serviceName: string
	readonly pageViews: number
	readonly clickCount: number
	readonly errorCount: number
	readonly traceCount: number
}

function parseTs(startTime: string): number {
	return Date.parse(normalizeTimestampInput(startTime))
}

function formatRelative(startTime: string): string {
	const parsed = parseTs(startTime)
	if (Number.isNaN(parsed)) return startTime
	const s = Math.round((Date.now() - parsed) / 1000)
	if (s < 60) return "just now"
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ago`
	const d = Math.floor(h / 24)
	return d < 7 ? `${d}d ago` : new Date(parsed).toLocaleDateString()
}

function absoluteTs(startTime: string): string {
	const parsed = parseTs(startTime)
	return Number.isNaN(parsed) ? startTime : new Date(parsed).toLocaleString()
}

function identity(session: SessionRow): { label: string; initial: string; gradient: string } {
	const label = session.userId || "Anonymous"
	return {
		label,
		initial: (label[0] ?? "?").toUpperCase(),
		gradient: gradientFor(session.sessionId),
	}
}

export function SessionsTable({ sessions }: { sessions: ReadonlyArray<SessionRow> }) {
	const navigate = useNavigate()

	if (sessions.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
				<div className="mb-4 grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
					<EyeIcon className="size-6" />
				</div>
				<p className="text-sm font-medium">No sessions recorded yet</p>
				<p className="mt-1.5 max-w-md text-sm text-muted-foreground">
					Install{" "}
					<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
						@maple/browser
					</code>{" "}
					and call{" "}
					<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
						MapleBrowser.init()
					</code>{" "}
					to start capturing what your users see.
				</p>
			</div>
		)
	}

	return (
		<div className="overflow-hidden rounded-xl border border-border">
			<Table>
				<TableHeader>
					<TableRow className="bg-muted/40 hover:bg-muted/40">
						<TableHead className="h-9 ps-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Session
						</TableHead>
						<TableHead className="h-9 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Page
						</TableHead>
						<TableHead className="h-9 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Environment
						</TableHead>
						<TableHead className="h-9 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Activity
						</TableHead>
						<TableHead className="h-9 pe-4 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Started
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{sessions.map((session) => {
						const id = identity(session)
						const isActive = session.status === "active"
						return (
							<TableRow
								key={session.sessionId}
								className="group cursor-pointer transition-colors hover:bg-muted/50"
								onClick={() =>
									navigate({
										to: "/replays/$sessionId",
										params: { sessionId: session.sessionId },
										search: { t: session.startTime },
									})
								}
							>
								<TableCell className="ps-4">
									<div className="flex items-center gap-3">
										<div
											className={`grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br ${id.gradient} text-sm font-semibold text-white shadow-sm`}
										>
											{id.initial}
										</div>
										<div className="min-w-0">
											<div className="flex items-center gap-1.5">
												<span className="max-w-44 truncate text-sm font-medium">{id.label}</span>
												<StatusDot active={isActive} />
											</div>
											<div className="font-mono text-xs text-muted-foreground">
												{session.sessionId.slice(0, 8)} · {formatDuration(session.durationMs)}
											</div>
										</div>
									</div>
								</TableCell>

								<TableCell>
									<div className="flex max-w-56 items-center gap-1.5 text-sm text-muted-foreground">
										<GlobeIcon className="size-3.5 shrink-0 opacity-60" />
										<span className="truncate">{hostFromUrl(session.urlInitial)}</span>
									</div>
								</TableCell>

								<TableCell>
									<div className="flex items-center gap-1.5 text-sm">
										<ComputerIcon className="size-3.5 shrink-0 text-muted-foreground" />
										<span className="truncate">
											{session.browserName || "Unknown"}
											<span className="text-muted-foreground">
												{session.osName ? ` · ${session.osName}` : ""}
											</span>
										</span>
									</div>
								</TableCell>

								<TableCell>
									<div className="flex items-center gap-2.5 text-xs text-muted-foreground">
										<Stat
											icon={<PulseIcon className="size-3.5" />}
											value={session.clickCount}
											title="clicks"
										/>
										<Stat
											icon={<EyeIcon className="size-3.5" />}
											value={session.pageViews || 1}
											title="page views"
										/>
										{session.traceCount > 0 && (
											<span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 font-medium tabular-nums text-primary">
												{session.traceCount} trace{session.traceCount === 1 ? "" : "s"}
											</span>
										)}
										{session.errorCount > 0 && (
											<span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 font-medium tabular-nums text-destructive">
												<CircleWarningIcon className="size-3" />
												{session.errorCount}
											</span>
										)}
									</div>
								</TableCell>

								<TableCell className="pe-4 text-right">
									<div className="flex items-center justify-end gap-3">
										<span
											className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground"
											title={absoluteTs(session.startTime)}
										>
											<ClockIcon className="size-3.5 opacity-60" />
											{formatRelative(session.startTime)}
										</span>
										<span className="grid size-7 place-items-center rounded-full bg-primary/10 text-primary opacity-0 transition-opacity group-hover:opacity-100">
											<PlayGlyph />
										</span>
									</div>
								</TableCell>
							</TableRow>
						)
					})}
				</TableBody>
			</Table>
		</div>
	)
}

function StatusDot({ active }: { active: boolean }) {
	if (!active)
		return <span className="size-1.5 rounded-full bg-muted-foreground/40" title="ended" />
	return (
		<span className="relative flex size-1.5" title="active">
			<span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
			<span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
		</span>
	)
}

function Stat({ icon, value, title }: { icon: React.ReactNode; value: number; title: string }) {
	return (
		<span className="inline-flex items-center gap-1 tabular-nums" title={title}>
			<span className="opacity-60">{icon}</span>
			{value}
		</span>
	)
}

function PlayGlyph() {
	return (
		<svg viewBox="0 0 24 24" className="size-3.5 translate-x-px fill-current" aria-hidden>
			<path d="M8 5v14l11-7z" />
		</svg>
	)
}
