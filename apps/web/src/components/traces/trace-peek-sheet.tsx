import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useHotkeys } from "@tanstack/react-hotkeys"
import { Schema } from "effect"
import { TraceId } from "@maple/domain"

import { Button } from "@maple/ui/components/ui/button"
import { Kbd } from "@maple/ui/components/ui/kbd"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@maple/ui/components/ui/resizable"
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@maple/ui/components/ui/sheet"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { TraceViewTabs } from "@maple/ui/components/traces/trace-view-tabs"
import { findSpanById } from "@maple/ui/components/traces/flow-utils"
import { getHttpInfo } from "@maple/ui/lib/http"

import type { Span, SpanHierarchyResponse, SpanNode } from "@/api/warehouse/traces"
import { ArrowDownIcon, ArrowUpIcon } from "@/components/icons"
import { QueryErrorState } from "@/components/common/query-error-state"
import { TraceReplayLink } from "@/components/replays/trace-replay-link"
import { SpanDetailPanel } from "@/components/traces/span-detail-panel"
import { TraceAnatomyStrip } from "@/components/traces/trace-anatomy-strip"
import { TraceIdBadge } from "@/components/traces/trace-id-badge"
import { TraceLogsLink } from "@/components/traces/trace-logs-link"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { getSpanHierarchyResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { PeekTarget } from "@/lib/traces/peek"

/**
 * The peek: a trace's page, in a sheet, without leaving the list.
 *
 * Triage is a walk down a sorted list, and a full navigation per row costs the
 * sort, the scroll and the filters each time. The sheet shows what the trace
 * page would — anatomy strip, waterfall, span detail — and ↑/↓ walk the list
 * behind it. "Open trace" (or Enter) is there when a row earns the whole page.
 *
 * The same row still opens the page on a modified, middle or right click, so
 * nothing is a setting: both are one click away, every time.
 */

/** ↓/J step forward, ↑/K back — the list idiom, mirrored in the footer hint. */
function stepFor(key: string): 1 | -1 | undefined {
	switch (key) {
		case "ArrowDown":
		case "j":
		case "J":
			return 1
		case "ArrowUp":
		case "k":
		case "K":
			return -1
		default:
			return undefined
	}
}

function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.isContentEditable
	)
}

/**
 * A control the user chose to focus keeps its own Enter — a Tab-reachable
 * button, link or tab. Waterfall rows are `role="button"` divs and the timeline's
 * rows are `tabIndex={-1}` buttons, and a click lands focus on them; neither is
 * a choice to press *that* thing with Enter, so Enter still opens the page.
 */
function keepsEnter(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	const control = target.closest("a, button, [role='tab'], [role='menuitem'], [role='option']")
	return control instanceof HTMLElement && control.tabIndex >= 0
}

interface TracePeekSheetProps {
	target: PeekTarget | null
	/** Where the trace sits in the loaded list, for the footer's "3 of 50" and the arrows. `null` when the row is not loaded. */
	position: { index: number; count: number } | null
	/** The span selected inside the peek; lives in the URL like the page's `spanId`. */
	selectedSpanId: string | undefined
	onSelectSpan: (spanId: string | undefined) => void
	onStep: (delta: 1 | -1) => void
	onClose: () => void
}

export function TracePeekSheet({
	target,
	position,
	selectedSpanId,
	onSelectSpan,
	onStep,
	onClose,
}: TracePeekSheetProps) {
	/**
	 * Keys are handled in two places, split by where focus is — the same shape
	 * as the pod peek. Inside the popup, in the CAPTURE phase, so the waterfall's
	 * own arrow handling cannot swallow a step. Outside it, as document hotkeys,
	 * for a page that loaded with `peek` already in the URL; that handler yields
	 * whenever the press came from inside, so a key is handled exactly once.
	 */
	const popupRef = React.useRef<HTMLDivElement>(null)
	const openPageRef = React.useRef<HTMLAnchorElement>(null)

	const handleKeyDownCapture = (event: React.KeyboardEvent<HTMLElement>) => {
		if (event.metaKey || event.ctrlKey || event.altKey) return
		if (isTextEntry(event.target)) return
		if (event.key === "Enter") {
			if (keepsEnter(event.target)) return
			event.preventDefault()
			event.stopPropagation()
			openPageRef.current?.click()
			return
		}
		const delta = stepFor(event.key)
		if (delta === undefined) return
		event.preventDefault()
		event.stopPropagation()
		onStep(delta)
	}

	const fromOutside = (event: KeyboardEvent) =>
		!(event.target instanceof Node && popupRef.current?.contains(event.target))

	useHotkeys(
		[
			{ hotkey: "ArrowDown", callback: (e) => fromOutside(e) && onStep(1) },
			{ hotkey: "J", callback: (e) => fromOutside(e) && onStep(1) },
			{ hotkey: "ArrowUp", callback: (e) => fromOutside(e) && onStep(-1) },
			{ hotkey: "K", callback: (e) => fromOutside(e) && onStep(-1) },
			{
				// Enter promotes the peek to the page (the outside-focus path; inside,
				// the capture handler above does it).
				hotkey: "Enter",
				callback: (e) => {
					if (!fromOutside(e) || keepsEnter(e.target)) return
					openPageRef.current?.click()
				},
				options: { preventDefault: false },
			},
		],
		// `stopPropagation: false` so Base UI's own document-level key handling
		// (Escape closes the sheet) is never starved.
		{ enabled: target !== null, ignoreInputs: true, stopPropagation: false },
	)

	const canStepBack = position !== null && position.index > 0
	const canStepForward = position !== null && position.index < position.count - 1

	return (
		<Sheet open={target !== null} onOpenChange={(open) => !open && onClose()}>
			{/* Focus lands on the popup itself, not its first control: Enter and the
			    arrows then mean the sheet's shortcuts until the user Tabs to a control. */}
			<SheetContent
				ref={popupRef}
				initialFocus={popupRef}
				className="w-[min(1100px,calc(100vw-2rem))] p-0 sm:max-w-[min(1100px,calc(100vw-2rem))]"
				onKeyDownCapture={handleKeyDownCapture}
			>
				{target ? (
					<>
						<TracePeekBody
							target={target}
							selectedSpanId={selectedSpanId}
							onSelectSpan={onSelectSpan}
						/>

						<SheetFooter className="flex-row items-center justify-between gap-3 border-t">
							<div className="flex items-center gap-1.5">
								<Button
									variant="outline"
									size="icon-sm"
									aria-label="Previous trace"
									title="Previous trace (↑ or K)"
									disabled={!canStepBack}
									onClick={() => onStep(-1)}
								>
									<ArrowUpIcon size={14} />
								</Button>
								<Button
									variant="outline"
									size="icon-sm"
									aria-label="Next trace"
									title="Next trace (↓ or J)"
									disabled={!canStepForward}
									onClick={() => onStep(1)}
								>
									<ArrowDownIcon size={14} />
								</Button>
								{position ? (
									<span className="ml-1 font-mono text-[11px] tabular-nums text-muted-foreground">
										{position.index + 1} of {position.count}
									</span>
								) : null}
							</div>
							<Button
								size="sm"
								render={
									<Link
										ref={openPageRef}
										to="/traces/$traceId"
										params={{ traceId: target.traceId }}
										search={(prev: Record<string, unknown>) => ({
											...prev,
											peek: undefined,
											peekRow: undefined,
											peekT: undefined,
											peekSpan: undefined,
											t: target.startTime,
											spanId: selectedSpanId,
										})}
									/>
								}
							>
								Open trace
								<Kbd className="ml-1 hidden bg-black/15 text-current sm:inline-flex">↵</Kbd>
							</Button>
						</SheetFooter>
					</>
				) : null}
			</SheetContent>
		</Sheet>
	)
}

function TracePeekBody({
	target,
	selectedSpanId,
	onSelectSpan,
}: {
	target: PeekTarget
	selectedSpanId: string | undefined
	onSelectSpan: (spanId: string | undefined) => void
}) {
	// `timestamp` narrows the partition scan the way the page's `t` does; a row
	// knows when its trace started, and a bare URL carries it as `peekT`.
	const result = useAtomValue(
		getSpanHierarchyResultAtom({
			data: { traceId: Schema.decodeSync(TraceId)(target.traceId), timestamp: target.startTime },
		}),
	)

	return Result.builder(result)
		.onInitial(() => (
			<>
				<SheetHeader className="gap-1.5 pr-14">
					<span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
						Trace
					</span>
					<SheetTitle className="font-mono text-[15px]">{target.traceId.slice(0, 8)}</SheetTitle>
					<SheetDescription className="sr-only">Loading trace details</SheetDescription>
				</SheetHeader>
				<div className="flex-1 space-y-3 overflow-hidden p-4">
					<Skeleton className="h-1.5 w-full rounded-full" />
					<div className="rounded-md border">
						{Array.from({ length: 6 }).map((_, i) => (
							<div key={i} className="flex items-center gap-2 border-b p-3 last:border-0">
								<Skeleton className="size-4" />
								<Skeleton className="h-4 w-20" />
								<Skeleton className="h-4 flex-1" />
								<Skeleton className="h-2 w-32" />
							</div>
						))}
					</div>
				</div>
			</>
		))
		.onError((error) => (
			<>
				<SheetHeader className="pr-14">
					<SheetTitle className="font-mono text-[15px]">{target.traceId.slice(0, 8)}</SheetTitle>
					<SheetDescription className="sr-only">Failed to load trace</SheetDescription>
				</SheetHeader>
				<div className="flex-1 overflow-auto p-4">
					<QueryErrorState error={error} titleOverride="Failed to load trace details" />
				</div>
			</>
		))
		.onSuccess((data, r) => (
			<TracePeekLoaded
				data={data}
				waiting={r.waiting ?? false}
				selectedSpanId={selectedSpanId}
				onSelectSpan={onSelectSpan}
			/>
		))
		.render()
}

function TracePeekLoaded({
	data,
	waiting,
	selectedSpanId,
	onSelectSpan,
}: {
	data: SpanHierarchyResponse
	/**
	 * A step hands back the previous trace's data flagged waiting; dim it rather
	 * than flashing a skeleton. Everything shown, the id included, comes from
	 * `data` so the dimmed view stays a coherent picture of the previous trace
	 * and never mixes the next id with the last spans.
	 */
	waiting: boolean
	selectedSpanId: string | undefined
	onSelectSpan: (spanId: string | undefined) => void
}) {
	const traceId = data.traceId
	const rootSpan = data.rootSpans[0]
	const traceStartTime = data.traceStartTime

	const selectedSpan = React.useMemo(
		() => (selectedSpanId ? (findSpanById(data.rootSpans, selectedSpanId) ?? null) : null),
		[data.rootSpans, selectedSpanId],
	)
	const services = React.useMemo(
		() => [...new Set(data.spans.map((s: Span) => s.serviceName))],
		[data.spans],
	)
	const handleSelectSpan = React.useCallback((span: SpanNode) => onSelectSpan(span.spanId), [onSelectSpan])
	const handleCloseSpan = React.useCallback(() => onSelectSpan(undefined), [onSelectSpan])

	if (!rootSpan || traceStartTime === undefined) {
		return (
			<>
				<SheetHeader className="pr-14">
					<SheetTitle className="font-mono text-[15px]">{traceId.slice(0, 8)}</SheetTitle>
					<SheetDescription>
						{data.spans.length === 0
							? "This trace could not be found. It may have expired or not been ingested yet."
							: `Found ${data.spans.length} span${data.spans.length !== 1 ? "s" : ""}, but the root span is missing.`}
					</SheetDescription>
				</SheetHeader>
				<div className="flex flex-1 flex-col items-center justify-center p-8">
					<TraceIdBadge traceId={traceId} />
				</div>
			</>
		)
	}

	const rootHttpInfo = getHttpInfo(rootSpan)
	const hasError = data.spans.some((s: Span) => {
		if (s.statusCode === "Error") return true
		const httpStatus = s.spanAttributes?.["http.status_code"]
		const code = typeof httpStatus === "string" ? parseInt(httpStatus) : httpStatus
		return typeof code === "number" && code >= 500
	})

	return (
		<div className={`flex min-h-0 flex-1 flex-col transition-opacity ${waiting ? "opacity-50" : ""}`}>
			<SheetHeader className="gap-1.5 pr-14">
				<span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
					Trace
				</span>
				<SheetTitle className="min-w-0 text-[15px] leading-tight">
					<HttpSpanLabel
						spanName={rootSpan.spanName}
						spanAttributes={rootSpan.spanAttributes}
						spanKind={rootSpan.spanKind}
						className="gap-3"
					/>
				</SheetTitle>
				<SheetDescription className="sr-only">Spans and timing for trace {traceId}</SheetDescription>
				<div className="flex flex-wrap items-center gap-2">
					<TraceIdBadge traceId={traceId} size="sm" className="max-w-[260px]" />
					<TraceLogsLink
						traceId={traceId}
						traceStartTime={traceStartTime}
						totalDurationMs={data.totalDurationMs}
					/>
					<TraceReplayLink traceId={traceId} />
				</div>
			</SheetHeader>

			<div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
				<TraceAnatomyStrip
					spans={data.spans}
					totalDurationMs={data.totalDurationMs}
					traceId={traceId}
					hasError={hasError}
					httpStatusCode={rootHttpInfo?.statusCode}
					deploymentEnv={rootSpan.resourceAttributes?.["deployment.environment"]}
					commitSha={rootSpan.resourceAttributes?.["vcs.ref.head.revision"]}
				/>

				{/* Stacked, not side by side: the sheet is narrower than the page, and a
				    60/40 horizontal split would leave the waterfall unreadable. */}
				<ResizablePanelGroup
					orientation="vertical"
					className="min-h-0 flex-1 overflow-hidden rounded-md border"
				>
					<ResizablePanel defaultSize={selectedSpan ? 55 : 100} minSize={30}>
						<TraceViewTabs
							rootSpans={data.rootSpans}
							spans={data.spans}
							totalDurationMs={data.totalDurationMs}
							traceStartTime={traceStartTime}
							services={services}
							selectedSpanId={selectedSpan?.spanId}
							onSelectSpan={handleSelectSpan}
						/>
					</ResizablePanel>
					{selectedSpan && (
						<>
							<ResizableHandle withHandle />
							<ResizablePanel defaultSize={45} minSize={25}>
								<SpanDetailPanel
									span={selectedSpan}
									onClose={handleCloseSpan}
									traceStartTime={traceStartTime}
									totalDurationMs={data.totalDurationMs}
								/>
							</ResizablePanel>
						</>
					)}
				</ResizablePanelGroup>
			</div>
		</div>
	)
}
