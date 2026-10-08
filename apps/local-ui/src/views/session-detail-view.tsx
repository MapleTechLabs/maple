import type { ReactNode } from "react"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { shortId } from "@maple/ui/lib/ids"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CircleWarningIcon,
	ClockIcon,
	CodeIcon,
	ComputerIcon,
	GlobeIcon,
	MobileIcon,
	NetworkNodesIcon,
	PulseIcon,
} from "@maple/ui/components/icons"
import { cn } from "@maple/ui/lib/utils"
import { formatDuration } from "@maple/ui/lib/format"
import type { SessionTranscriptOutput } from "@maple/query-engine/ch"
import {
	useLocalSessionDetail,
	useLocalSessionTraces,
	useLocalSessionTranscript,
} from "../hooks/use-local-session-detail"
import { hrefFor } from "../lib/router"
import {
	formatLocalDateTime,
	formatRelativeTime,
	formatUtcTitle,
	parseClickHouseDateTime,
	type WarehouseTime,
} from "../lib/time"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { gradientFor, hostFromUrl, isMobileDevice } from "@maple/ui/lib/replay"
import { ErrorState } from "../components/view-states"
import { RefreshButton } from "../components/toolbar"

interface SessionDetailViewProps {
	sessionId: string
	backLabel: string
	onBack: () => void
}

export function SessionDetailView({ sessionId, backLabel, onBack }: SessionDetailViewProps) {
	const detail = useLocalSessionDetail(sessionId)
	const { data: session, isPending, isError, error } = detail
	const traceIds = session?.traceIds ?? []
	const traces = useLocalSessionTraces(traceIds)
	const transcript = useLocalSessionTranscript(sessionId)

	const isActive = session?.status === "active"
	const hasError = (session?.errorCount ?? 0) > 0
	const label = session?.userId || "Anonymous"
	const DeviceIcon = session && isMobileDevice(session.deviceType) ? MobileIcon : ComputerIcon

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
					<ArrowLeftIcon size={14} />
					{backLabel}
				</Button>
				<TruncatedText mono className="text-xs text-muted-foreground">
					{sessionId}
				</TruncatedText>
				<RefreshButton className="ml-auto" since={detail.dataUpdatedAt} />
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{isPending ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : isError ? (
					<ErrorState label="session" error={error} onRetry={() => detail.refetch()} />
				) : !session ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						Session not found.
					</div>
				) : (
					<div className="mx-auto max-w-5xl px-4 py-5">
						{/* Hero */}
						<div className="flex flex-wrap items-center gap-4 border-b pb-5">
							<div
								className={`grid size-12 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(sessionId)} text-base font-semibold text-white shadow-sm`}
							>
								{(label[0] ?? "?").toUpperCase()}
							</div>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<h1 className="truncate text-xl font-semibold tracking-tight">{label}</h1>
									<StatusBadge active={isActive} />
								</div>
								<div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
									<TruncatedId
										value={sessionId}
										kind="session"
										length={8}
										className="text-xs"
									/>
									<span className="inline-flex items-center gap-1.5">
										<DeviceIcon className="size-3.5 opacity-60" />
										{session.browserName || "Unknown"}
										{session.osName ? ` · ${session.osName}` : ""}
									</span>
									<span
										className="inline-flex items-center gap-1.5"
										title={`${formatLocalDateTime(session.startTime)} (${formatUtcTitle(session.startTime)})`}
									>
										<ClockIcon className="size-3.5 opacity-60" />
										started {formatRelativeTime(session.startTime)}
									</span>
								</div>
							</div>
						</div>

						{/* Stat tiles */}
						<div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
							<StatTile
								label="Duration"
								value={isActive ? "Live" : formatSessionDuration(session.durationMs)}
							/>
							<StatTile label="Page views" value={String(session.pageViews)} />
							<StatTile label="Clicks" value={String(session.clickCount)} />
							<StatTile label="Errors" value={String(session.errorCount)} danger={hasError} />
							<StatTile label="Traces" value={String(traceIds.length)} />
						</div>

						<div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
							<div className="flex flex-col gap-5">
								<Card title="Client">
									<KeyValueList
										layout="stacked"
										className="grid-cols-2 gap-x-4 gap-y-3 text-sm [&_dt]:text-xs"
									>
										<KeyValue label="User">
											<TruncatedText text={label}>{label || "-"}</TruncatedText>
										</KeyValue>
										<KeyValue label="Browser">
											<TruncatedText text={session.browserName}>
												{session.browserName || "-"}
											</TruncatedText>
										</KeyValue>
										<KeyValue label="OS">
											<TruncatedText text={session.osName}>
												{session.osName || "-"}
											</TruncatedText>
										</KeyValue>
										<KeyValue label="Device">
											<TruncatedText text={session.deviceType}>
												{session.deviceType || "-"}
											</TruncatedText>
										</KeyValue>
										<KeyValue label="Service">
											<TruncatedText text={session.serviceName}>
												{session.serviceName || "-"}
											</TruncatedText>
										</KeyValue>
										<KeyValue label="Entry URL" className="col-span-2">
											<TruncatedText text={session.urlInitial}>
												{hostFromUrl(session.urlInitial) || "-"}
											</TruncatedText>
										</KeyValue>
										<KeyValue label="User agent" className="col-span-2">
											<TruncatedText text={session.userAgent}>
												{session.userAgent || "-"}
											</TruncatedText>
										</KeyValue>
									</KeyValueList>
								</Card>

								<Card title={`Correlated traces · ${traceIds.length}`}>
									{traceIds.length === 0 ? (
										<p className="text-sm text-muted-foreground">
											No backend traces correlated.
										</p>
									) : traces.isPending ? (
										<Spinner className="size-4" />
									) : (
										<ul className="space-y-1.5">
											{(traces.data ?? []).map((trace) => (
												<li key={trace.traceId}>
													<a
														href={hrefFor(
															`/traces/${encodeURIComponent(trace.traceId)}`,
														)}
														className="group flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
													>
														<span
															className={cn(
																"size-1.5 shrink-0 rounded-full",
																trace.hasError
																	? "bg-severity-error"
																	: "bg-muted-foreground/40",
															)}
														/>
														<span className="min-w-0 flex-1">
															<span className="block truncate text-sm">
																{trace.rootSpanName ||
																	shortId(trace.traceId, "trace", {
																		length: 12,
																	})}
															</span>
															<span className="block truncate text-xs text-muted-foreground">
																{trace.rootServiceName || "unknown"} ·{" "}
																{trace.spanCount} spans
															</span>
														</span>
														<span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
															{formatDuration(trace.durationMs)}
														</span>
														<ArrowRightIcon
															size={14}
															className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
														/>
													</a>
												</li>
											))}
										</ul>
									)}
								</Card>
							</div>

							<Card title="Event transcript">
								{transcript.isPending ? (
									<Spinner className="size-4" />
								) : transcript.isError ? (
									<ErrorState label="transcript" error={transcript.error} />
								) : (transcript.data?.length ?? 0) === 0 ? (
									<p className="text-sm text-muted-foreground">
										No distilled events for this session.
									</p>
								) : (
									<Transcript
										events={transcript.data ?? []}
										startTime={session.startTime}
									/>
								)}
							</Card>
						</div>
					</div>
				)}
			</div>
		</div>
	)
}

// Transcript

function offsetLabel(startTime: WarehouseTime, ts: WarehouseTime): string {
	const start = parseClickHouseDateTime(startTime)
	const at = parseClickHouseDateTime(ts)
	if (start === null || at === null) return ""
	const deltaMs = Math.max(0, at - start)
	if (deltaMs < 1000) return `+${deltaMs}ms`
	return `+${(deltaMs / 1000).toFixed(1)}s`
}

function EventIcon({ event }: { event: SessionTranscriptOutput }) {
	const className = "size-3.5"
	switch (event.type) {
		case "navigation":
			return <GlobeIcon className={className} />
		case "click":
		case "input":
			return <PulseIcon className={className} />
		case "console":
			return <CodeIcon className={className} />
		case "network":
			return <NetworkNodesIcon className={className} />
		case "error":
			return <CircleWarningIcon className={className} />
		default:
			return <CodeIcon className={className} />
	}
}

function isErrorEvent(event: SessionTranscriptOutput): boolean {
	return (
		event.type === "error" ||
		(event.type === "console" && event.level === "error") ||
		(event.type === "network" && event.netStatus >= 400)
	)
}

function Transcript({
	events,
	startTime,
}: {
	events: ReadonlyArray<SessionTranscriptOutput>
	startTime: WarehouseTime
}) {
	return (
		<ol className="space-y-3">
			{events.map((event) => {
				const danger = isErrorEvent(event)
				return (
					<li key={`${event.seq}-${event.timestamp}`} className="flex gap-3">
						<span
							className={cn(
								"mt-0.5 grid size-6 shrink-0 place-items-center rounded-full",
								danger
									? "bg-severity-error/10 text-severity-error"
									: "bg-muted text-muted-foreground",
							)}
						>
							<EventIcon event={event} />
						</span>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline justify-between gap-2">
								<span className="text-xs font-medium capitalize">{event.type}</span>
								<span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
									{offsetLabel(startTime, event.timestamp)}
								</span>
							</div>
							<TranscriptBody event={event} />
						</div>
					</li>
				)
			})}
		</ol>
	)
}

function TranscriptBody({ event }: { event: SessionTranscriptOutput }) {
	switch (event.type) {
		case "navigation":
			return <p className="truncate text-xs text-muted-foreground">{event.url || "-"}</p>
		case "click":
			return (
				<p className="truncate text-xs text-muted-foreground">
					{event.targetText || event.targetSelector || "element"}
				</p>
			)
		case "input":
			return (
				<p className="truncate font-mono text-xs text-muted-foreground">
					{event.targetSelector || "input"}
				</p>
			)
		case "console":
			return <p className="break-words text-xs text-muted-foreground">{event.message}</p>
		case "network":
			return (
				<p className="truncate text-xs text-muted-foreground">
					<span className="font-medium text-foreground">{event.netMethod}</span> {event.netUrl}
					<span
						className={cn("ml-1.5 tabular-nums", event.netStatus >= 400 && "text-severity-error")}
					>
						{event.netStatus || "-"} · {Math.round(event.netDurationMs)}ms
					</span>
				</p>
			)
		case "error":
			return (
				<div>
					<p className="break-words text-xs text-severity-error">{event.message}</p>
					{event.errorStack ? (
						<pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-1.5 font-mono text-[10px] text-muted-foreground">
							{event.errorStack}
						</pre>
					) : null}
				</div>
			)
		default:
			return <p className="truncate text-xs text-muted-foreground">{event.message}</p>
	}
}

// Bits

function StatusBadge({ active }: { active: boolean }) {
	if (active) {
		return (
			<Badge variant="ok" pill className="gap-1.5">
				<StatusDot tone="ok" />
				Active
			</Badge>
		)
	}
	return (
		<Badge variant="muted" pill>
			Ended
		</Badge>
	)
}

function StatTile({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
	return (
		<div className="rounded-xl border bg-card px-3 py-2.5">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p
				className={cn(
					"mt-1 text-2xl font-semibold tabular-nums tracking-tight",
					danger && "text-severity-error",
				)}
			>
				{value}
			</p>
		</div>
	)
}

function Card({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="rounded-xl border bg-card p-4">
			<h2 className="mb-3 text-sm font-medium">{title}</h2>
			{children}
		</section>
	)
}
