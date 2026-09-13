import { cn } from "@maple/ui/lib/utils"
import { formatErrorRate } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { formatToolCount } from "@/lib/agent-sessions/tool-analytics"
import type { ErrorPathPart, ErrorTextToken, FailureStatus } from "@/lib/agent-sessions/tool-error-display"

// The pieces the Errors table and the error group modal both draw a failure
// with, so a message, a trend and a status read the same in the row and in the
// modal it opens.

/** A span of text the grouping ignores, drawn as the kind of value it is. The
 *  raw text is its tooltip. */
export function MaskChip({ label, raw, className }: { label: string; raw: string; className?: string }) {
	return (
		<span
			title={raw === "" ? undefined : raw}
			className={cn(
				"mx-px inline-block rounded-[3px] bg-muted px-[3px] align-baseline font-mono text-[11.5px] leading-[15px] font-normal text-muted-foreground",
				className,
			)}
		>
			{label}
		</span>
	)
}

function PathParts({
	parts,
	keyClassName,
	maskClassName,
}: {
	parts: ReadonlyArray<ErrorPathPart>
	keyClassName: string
	maskClassName?: string
}) {
	return (
		<>
			{parts.map((part, index) =>
				part.kind === "key" ? (
					<span key={index} className={keyClassName}>
						{part.text}
					</span>
				) : (
					<MaskChip key={index} label={part.label} raw={part.raw} className={maskClassName} />
				),
			)}
		</>
	)
}

function LineToken({ token }: { token: ErrorTextToken }) {
	switch (token.kind) {
		case "text":
			return <span className="text-foreground/80">{token.text}</span>
		case "value":
			return <span className="font-medium text-foreground">{token.text}</span>
		case "mask":
			return <MaskChip label={token.label} raw={token.raw} />
		case "at":
			return <span className="text-muted-foreground/60"> at </span>
		case "break":
			return <span className="text-muted-foreground/60"> ⏎ </span>
		case "path":
			return <PathParts parts={token.parts} keyClassName="font-medium text-foreground" />
	}
}

const lineTokens = (tokens: ReadonlyArray<ErrorTextToken>) =>
	tokens.map((token, index) => <LineToken key={index} token={token} />)

/**
 * A message on one line, as a row draws it.
 *
 * The error path is the part that has to survive a narrow column — it is WHERE
 * the failure is, and the groups beside it differ by nothing else — so it never
 * shrinks. The text before it gives way first; the text after it only takes
 * what is left over.
 */
export function ErrorTextLine({ tokens, className }: { tokens: ReadonlyArray<ErrorTextToken>; className?: string }) {
	const pathIndex = tokens.findIndex((token) => token.kind === "path")
	if (pathIndex < 0) {
		return <span className={cn("min-w-0 truncate whitespace-pre", className)}>{lineTokens(tokens)}</span>
	}
	const atIndex = tokens[pathIndex - 1]?.kind === "at" ? pathIndex - 1 : pathIndex
	const tail = tokens.slice(pathIndex + 1)
	return (
		<span className={cn("flex min-w-0 items-baseline", className)}>
			<span className="min-w-0 truncate whitespace-pre">{lineTokens(tokens.slice(0, atIndex))}</span>
			<span className="shrink-0 whitespace-pre">{lineTokens(tokens.slice(atIndex, pathIndex + 1))}</span>
			{tail.length > 0 ? (
				<span className="min-w-0 flex-[1_1_0] truncate whitespace-pre">{lineTokens(tail)}</span>
			) : null}
		</span>
	)
}

function HeadingToken({ token }: { token: ErrorTextToken }) {
	switch (token.kind) {
		case "text":
		case "value":
			return <>{token.text}</>
		case "mask":
			return <MaskChip label={token.label} raw={token.raw} className="border border-border bg-transparent text-[15px] leading-5" />
		case "at":
			return <span className="font-normal text-muted-foreground"> at </span>
		case "break":
			return <br />
		case "path":
			return <PathParts parts={token.parts} keyClassName="" />
	}
}

/**
 * The same message as the modal's heading: whole, and with its path on a line
 * of its own in the error colour — the one thing in the header a reader is
 * looking for.
 */
export function ErrorTextHeading({ tokens }: { tokens: ReadonlyArray<ErrorTextToken> }) {
	const pathIndex = tokens.findIndex((token) => token.kind === "path")
	const heading = "font-mono text-lg leading-[26px] font-semibold tracking-[-0.01em] text-foreground"
	if (pathIndex < 0) {
		return (
			<h2 className={cn(heading, "line-clamp-3 break-words")}>
				{tokens.map((token, index) => (
					<HeadingToken key={index} token={token} />
				))}
			</h2>
		)
	}
	const path = tokens[pathIndex]
	const atIndex = tokens[pathIndex - 1]?.kind === "at" ? pathIndex - 1 : pathIndex
	const tail = tokens.slice(pathIndex + 1)
	return (
		<h2 className="flex min-w-0 flex-col gap-0.5">
			<span className={cn(heading, "line-clamp-2 break-words")}>
				{tokens.slice(0, atIndex).map((token, index) => (
					<HeadingToken key={index} token={token} />
				))}
			</span>
			<span className="flex min-w-0 flex-wrap items-baseline gap-3 pl-6 font-mono text-lg leading-[26px]">
				<span className="text-muted-foreground">at</span>
				<span className="break-all font-semibold tracking-[-0.01em] text-[var(--severity-error)]">
					{path?.kind === "path" ? (
						<PathParts
							parts={path.parts}
							keyClassName=""
							maskClassName="border border-border bg-transparent text-[15px] leading-5"
						/>
					) : null}
				</span>
			</span>
			{tail.length > 0 ? (
				<span className="line-clamp-2 break-words pl-6 font-mono text-[13px] leading-[18px] text-foreground/85">
					{tail.map((token, index) => (
						<HeadingToken key={index} token={token} />
					))}
				</span>
			) : null}
		</h2>
	)
}

/** Failed calls per bucket: a bar where there were some, a floor where there
 *  were none, so a group that stopped reads as a row of empty buckets rather
 *  than a short chart. */
export function TrendBars({
	counts,
	width,
	height,
	radius = 1,
	className,
}: {
	counts: ReadonlyArray<number>
	width: number
	height: number
	radius?: number
	className?: string
}) {
	const gap = counts.length > 12 ? 1 : width > 200 ? 12 : 4
	const bar = Math.max(1, (width - gap * (counts.length - 1)) / Math.max(counts.length, 1))
	const max = Math.max(1, ...counts)
	return (
		<svg
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			className={cn("shrink-0", className)}
			aria-hidden
		>
			{counts.map((count, index) => {
				const x = index * (bar + gap)
				if (count === 0) {
					return <rect key={index} x={x} y={height - 2} width={bar} height={2} rx={1} fill="var(--input)" />
				}
				const barHeight = Math.max(3, Math.round((count / max) * height))
				return (
					<rect
						key={index}
						x={x}
						y={height - barHeight}
						width={bar}
						height={barHeight}
						rx={radius}
						fill="var(--severity-error)"
					/>
				)
			})}
		</svg>
	)
}

/** "Sep 4 – 11": the window as the trend column's head names it. */
export function windowRangeLabel(startMs: number, endMs: number, timeZone: string): string {
	const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone })
	const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone })
	const day = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone })
	const start = monthDay.format(startMs)
	if (start === monthDay.format(endMs)) return start
	return month.format(startMs) === month.format(endMs)
		? `${start} – ${day.format(endMs)}`
		: `${start} – ${monthDay.format(endMs)}`
}

const STATUS_DOT = {
	stopped: "bg-[var(--severity-info)]",
	ongoing: "bg-[var(--severity-error)]",
	quiet: "bg-muted-foreground",
} satisfies Record<FailureStatus["kind"], string>

const shortDate = (ms: number, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(ms)

const dateTime = (ms: number, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZone,
	}).format(ms)

/**
 * Whether failing has stopped, in one line.
 *
 * The TOOL's line (the Errors header) states its rate while it is failing; a
 * GROUP's (the modal) states how many of the trend's buckets it failed in. A
 * tool nobody has called since is said to be quiet — never fixed.
 */
export function FailureStatusLine({
	status,
	scope,
	timeZone,
	calls,
	failures,
	activeBuckets,
	className,
}: {
	status: FailureStatus
	scope: "tool" | "group"
	timeZone: string
	/** The tool's calls in the window. */
	calls: number
	failures: number
	/** A group's trend: buckets it failed in, of how many, and what a bucket is. */
	activeBuckets?: { readonly active: number; readonly total: number; readonly unit: string }
	className?: string
}) {
	const [lead, detail] =
		status.kind === "stopped"
			? [
					scope === "tool"
						? `No failures since ${dateTime(status.since, timeZone)}`
						: `None since ${shortDate(status.since, timeZone)}`,
					`· ${formatToolCount(status.callsSince)} call${status.callsSince === 1 ? "" : "s"} since`,
				]
			: status.kind === "quiet"
				? [`No calls since ${scope === "tool" ? dateTime(status.since, timeZone) : shortDate(status.since, timeZone)}`, undefined]
				: scope === "tool"
					? [
							`Last failure ${formatRelativeTimeOrDate(status.lastSeen, undefined, timeZone)}`,
							calls > 0 ? `· ${formatErrorRate(failures / calls)} of ${formatToolCount(calls)} calls` : undefined,
						]
					: [
							"Still happening",
							activeBuckets === undefined
								? undefined
								: `· failed in ${activeBuckets.active} of ${activeBuckets.total} ${activeBuckets.unit === "day" ? "days" : `${activeBuckets.unit} buckets`}`,
						]
	return (
		<span className={cn("flex items-center gap-2 font-mono text-[11.5px] leading-3.5", className)}>
			<span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status.kind])} />
			<span className="text-foreground">{lead}</span>
			{detail === undefined ? null : <span className="text-muted-foreground/70">{detail}</span>}
		</span>
	)
}
