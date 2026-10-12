import * as React from "react"
import { ChevronRightIcon, ChevronDownIcon, GlobeIcon } from "../icons"

import { Badge } from "../ui/badge"
import { IconButton } from "../ui/icon-button"
import { TruncatedId } from "../ui/truncated-id"
import { TruncatedText } from "../ui/truncated-text"
import { cn } from "../../lib/utils"
import { formatDuration } from "../../lib/format"
import { spanStartMs as spanStartMsOf } from "../../lib/span-tree"
import { getServiceColor } from "../../lib/colors"
import { getCacheInfo, cacheResultStyles } from "../../lib/cache"
import { getHttpInfo, HTTP_METHOD_COLORS, httpStatusTone } from "../../lib/http"
import { TONE_FILL, TONE_TEXT } from "../../lib/tone"
import { getCloudPlatform, outcomeBadgeStyle } from "../../lib/cloud-platforms"
import { getSpanKindLabel, getSpanStatusBadgeClass } from "../../lib/span-kind"
import { PixelDurationBar } from "./pixel-duration-bar"
import { ServiceDot } from "../service-dot"
import { countDescendants } from "./auto-collapse"
import type { SpanNode } from "../../lib/types"

interface SpanRowProps {
	span: SpanNode
	totalDurationMs: number
	traceStartTime: string
	expanded: boolean
	onToggle: (span: SpanNode) => void
	isSelected?: boolean
	onSelect?: (span: SpanNode) => void
}

/** Indent stops growing past this depth so deep traces keep room for the span name. */
const MAX_INDENT_DEPTH = 10

function DepthIndent({ depth }: { depth: number }) {
	if (depth <= 0) return null
	return (
		<>
			<div style={{ width: `${Math.min(depth, MAX_INDENT_DEPTH) * 24}px` }} className="shrink-0" />
			{depth > MAX_INDENT_DEPTH && (
				<span
					className="shrink-0 font-mono text-3xs tabular-nums text-muted-foreground"
					title={`Depth ${depth}`}
				>
					L{depth}
				</span>
			)}
		</>
	)
}

function SpanRowImpl({
	span,
	totalDurationMs,
	traceStartTime,
	expanded,
	onToggle,
	isSelected,
	onSelect,
}: SpanRowProps) {
	const hasChildren = span.children.length > 0

	if (span.isMissing) {
		return (
			<div
				className={cn(
					"@container/row group flex items-center border-b border-dashed py-1.5 px-2 bg-muted/30",
					isSelected && "bg-primary/5 border-l-2 border-l-primary",
				)}
			>
				<div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
					<DepthIndent depth={span.depth} />

					{hasChildren ? (
						<IconButton
							className="size-6 shrink-0"
							tooltip={false}
							label={expanded ? "Collapse span" : "Expand span"}
							onClick={(e) => {
								e.stopPropagation()
								onToggle(span)
							}}
						>
							{expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
						</IconButton>
					) : (
						<div className="w-6 shrink-0" />
					)}

					<Badge
						variant="outline"
						className="shrink-0 font-mono text-3xs px-1.5 border-dashed text-muted-foreground"
					>
						missing
					</Badge>

					<TruncatedText
						text={`Missing span: ${span.spanId}`}
						className="flex-1 font-mono text-xs italic text-muted-foreground"
					>
						Missing span
					</TruncatedText>
				</div>

				<div className="flex items-center gap-2 shrink-0 ml-2">
					<div className="hidden w-48 @min-[560px]/row:block" />
					<TruncatedId
						value={span.spanId}
						kind="span"
						className="w-16 text-right text-3xs text-muted-foreground/50 truncate"
					/>
					<div className="w-14" />
				</div>
			</div>
		)
	}

	const traceStartMs = new Date(traceStartTime).getTime()
	const spanStartMs = spanStartMsOf(span)

	const leftPercent = totalDurationMs > 0 ? ((spanStartMs - traceStartMs) / totalDurationMs) * 100 : 0

	const widthPercent = totalDurationMs > 0 ? (span.durationMs / totalDurationMs) * 100 : 0

	const cacheInfo = getCacheInfo(span.spanAttributes)
	const httpInfo = getHttpInfo(span)
	const platform = getCloudPlatform(span.spanAttributes)
	const statusStyle = getSpanStatusBadgeClass(span.statusCode)
	const kindLabel = getSpanKindLabel(span.spanKind)

	const httpTone = httpStatusTone(httpInfo?.statusCode)

	const barColor =
		httpTone === "crit"
			? TONE_FILL.crit
			: httpTone === "warn"
				? TONE_FILL.warn
				: span.statusCode === "Error"
					? TONE_FILL.crit
					: "bg-primary"

	return (
		<div
			className={cn(
				"@container/row group flex items-center border-b py-1.5 hover:bg-muted/50 cursor-pointer px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				span.statusCode === "Error" && "bg-severity-error/5",
				isSelected && "bg-primary/5 border-l-2 border-l-primary",
			)}
			role="button"
			tabIndex={0}
			onClick={() => onSelect?.(span)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					onSelect?.(span)
				}
			}}
		>
			{/* Left section: Toggle + Service + Kind + Span Name (variable width) */}
			{/* overflow-hidden so the shrink-0 children clip rather than paint over the right section */}
			<div className="@container flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
				{/* Indentation spacer based on depth */}
				<DepthIndent depth={span.depth} />

				{hasChildren ? (
					<IconButton
						className="size-6 shrink-0"
						tooltip={false}
						label={expanded ? "Collapse span" : "Expand span"}
						onClick={(e) => {
							e.stopPropagation()
							onToggle(span)
						}}
					>
						{expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
					</IconButton>
				) : (
					<div className="w-6 shrink-0" />
				)}

				<span className="flex min-w-0 max-w-[30%] shrink items-center gap-1.5 font-mono text-3xs">
					{platform && (
						<platform.Icon
							size={11}
							className={cn("shrink-0", platform.accentClassName)}
							aria-label={platform.label}
						/>
					)}
					<ServiceDot serviceName={span.serviceName} className="size-1.5" />
					<span
						className="min-w-0 truncate"
						style={{ color: getServiceColor(span.serviceName) }}
						title={span.serviceName}
					>
						{span.serviceName}
					</span>
					<span className="shrink-0 text-muted-foreground/60">{kindLabel}</span>
				</span>

				{platform?.edge && (
					<span
						className="hidden @min-[600px]:inline-flex items-center gap-1 shrink-0 font-mono text-3xs text-muted-foreground"
						title={platform.location ?? undefined}
					>
						<GlobeIcon size={10} className="shrink-0" />
						{platform.edge}
					</span>
				)}

				{httpInfo ? (
					<span
						className="flex-1 flex items-center gap-1.5 min-w-0 font-mono text-xs"
						title={httpInfo.route || span.spanName}
					>
						<span
							className={cn(
								"px-1 py-0.5 rounded text-3xs font-bold text-white shrink-0 leading-none hidden @min-[500px]:inline-flex",
								HTTP_METHOD_COLORS[httpInfo.method] || "bg-muted-foreground",
							)}
						>
							{httpInfo.method}
						</span>
						<span className="truncate">{httpInfo.route || span.spanName}</span>
					</span>
				) : (
					<TruncatedText mono className="flex-1 text-xs">
						{span.spanName}
					</TruncatedText>
				)}

				{hasChildren && !expanded && (
					<span className="shrink-0 text-3xs text-muted-foreground">+{countDescendants(span)}</span>
				)}
			</div>

			{/* Right section: Duration bar + Duration text + Status (fixed widths, anchored right) */}
			<div className="flex items-center gap-2 shrink-0 ml-2">
				<PixelDurationBar
					leftPercent={leftPercent}
					widthPercent={Math.max(widthPercent, 1)}
					color={barColor}
					className="hidden @min-[560px]/row:flex"
				/>

				<span className="w-16 text-right font-mono text-xs text-muted-foreground">
					{formatDuration(span.durationMs)}
				</span>

				{platform?.outcome?.bad && (
					<Badge
						variant="outline"
						className={cn(
							"text-3xs justify-center font-medium px-1.5 shrink-0",
							outcomeBadgeStyle(true),
						)}
						title={`${platform.label} outcome`}
					>
						{platform.outcome.value}
					</Badge>
				)}

				{cacheInfo?.result ? (
					<Badge
						variant="outline"
						className={cn(
							"text-3xs w-14 justify-center font-medium",
							cacheResultStyles[cacheInfo.result],
						)}
					>
						{cacheInfo.result === "hit" ? "HIT" : "MISS"}
					</Badge>
				) : httpInfo?.statusCode ? (
					<span
						className={cn(
							"w-14 text-center font-mono text-xs font-medium",
							httpTone !== "neutral"
								? TONE_TEXT[httpTone]
								: httpInfo.statusCode >= 300
									? "text-chart-p50"
									: "text-severity-info",
						)}
					>
						{httpInfo.statusCode}
					</span>
				) : (
					<Badge
						variant="outline"
						className={cn("text-3xs w-14 justify-center font-medium", statusStyle)}
					>
						{span.statusCode || "Unset"}
					</Badge>
				)}
			</div>
		</div>
	)
}

export const SpanRow = React.memo(SpanRowImpl)
