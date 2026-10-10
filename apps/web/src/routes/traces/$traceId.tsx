import { warmAtoms } from "@effect-router/core"
import * as React from "react"
import { useNavigate, useRouterState, createFileRoute } from "@tanstack/react-router"
import { useAtomValue } from "@/lib/effect-atom"
import { Option, Schema } from "effect"
import { TraceId } from "@maple/domain"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ResultPage } from "@/components/layout/result-page"
import { useAppHotkey } from "@/hooks/use-app-hotkey"
import { TraceReplayLink } from "@/components/replays/trace-replay-link"
import { TraceLogsLink } from "@/components/traces/trace-logs-link"
import { DocsLink } from "@/components/common/docs-link"
import { ResourceNotFound } from "@/components/common/resource-not-found"
import { TraceViewTabs } from "@maple/ui/components/traces/trace-view-tabs"
import { SpanDetailPanel } from "@/components/traces/span-detail-panel"
import { TraceAnatomyStrip } from "@/components/traces/trace-anatomy-strip"
import { TraceProductEvents } from "@/components/traces/trace-product-events"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@maple/ui/components/ui/resizable"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@maple/ui/components/ui/sheet"
import { useIsMobile } from "@maple/ui/hooks/use-media-query"
import { type Span, type SpanNode, type SpanHierarchyResponse } from "@/api/warehouse/traces"
import { getSpanHierarchyResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { findSpanById } from "@maple/ui/components/traces/flow-utils"
import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { TraceIdBadge } from "@/components/traces/trace-id-badge"
import { getHttpInfo, httpStatusTone } from "@maple/ui/lib/http"
import { shortId } from "@maple/ui/lib/ids"

const TraceDetailSearchSchema = Schema.Struct({
	spanId: Schema.optional(Schema.String),
	// Optional timestamp (any time inside the trace) carried in from the
	// referring page. Used to narrow the ClickHouse partition scan to a ±1h
	// window — without it the query reads every retained daily partition.
	t: Schema.optional(Schema.String),
})

/** A pasted id may carry whitespace; anything still undecodable renders the not-found state. */
const decodeTraceIdParam = (raw: string) => Option.getOrNull(Schema.decodeUnknownOption(TraceId)(raw.trim()))

function buildBackToTracesHref(searchStr: string): string {
	const params = new URLSearchParams(searchStr)
	params.delete("spanId")
	params.delete("t")
	const nextSearch = params.toString()
	return nextSearch ? `/traces?${nextSearch}` : "/traces"
}

export const Route = createFileRoute("/traces/$traceId")({
	component: TraceDetailPage,
	validateSearch: Schema.toStandardSchemaV1(TraceDetailSearchSchema),
	loaderDeps: ({ search }) => ({ t: search.t }),
	loader: ({ context, params, deps }) => {
		const traceId = decodeTraceIdParam(params.traceId)
		if (traceId === null) return
		warmAtoms(context.effectRegistry, [
			getSpanHierarchyResultAtom({ data: { traceId, timestamp: deps.t } }),
		])
	},
})

function TraceDetailPage() {
	const { traceId } = Route.useParams()
	const search = Route.useSearch()
	const searchStr = useRouterState({ select: (state) => state.location.searchStr })
	const backToTracesHref = buildBackToTracesHref(searchStr)
	const decodedTraceId = decodeTraceIdParam(traceId)
	const result = useAtomValue(
		decodedTraceId === null
			? disabledResultAtom<SpanHierarchyResponse>()
			: getSpanHierarchyResultAtom({ data: { traceId: decodedTraceId, timestamp: search.t } }),
	)

	return (
		<ResultPage
			breadcrumbs={[{ label: "Traces", href: backToTracesHref }]}
			result={result}
			// No spans (or no start time) is a trace that isn't there; a missing root is
			// a trace that is, so it still gets its crumb and a body of its own.
			select={(data) => {
				const traceStartTime = data.traceStartTime
				if (data.spans.length === 0 || traceStartTime === undefined) return null
				return { data, traceStartTime, rootSpan: data.rootSpans[0] }
			}}
			crumb={() => shortId(traceId, "trace")}
			errorTitle="Failed to load trace details"
			loading={<TraceDetailLoading />}
			invalid={
				decodedTraceId === null ? (
					<TraceNotFound
						traceId={traceId}
						backToTracesHref={backToTracesHref}
						title="Trace not found"
						description="This is not a valid trace ID. Check that the link was copied in full."
					/>
				) : undefined
			}
			notFound={
				<TraceNotFound
					traceId={traceId}
					backToTracesHref={backToTracesHref}
					title="Trace not found"
					description="This trace could not be found. It may have expired or not been ingested yet."
					footer={<DocsLink page="retention">How long traces are kept</DocsLink>}
				/>
			}
			titleContent={({ rootSpan }) => {
				if (!rootSpan) return undefined
				return getHttpInfo(rootSpan) ? (
					<DashboardLayout.Title className="min-w-0">
						<HttpSpanLabel
							spanName={rootSpan.spanName}
							spanAttributes={rootSpan.spanAttributes}
							spanKind={rootSpan.spanKind}
							className="gap-3"
						/>
					</DashboardLayout.Title>
				) : (
					// The breadcrumb only carries the short trace id; the root span name
					// is what identifies the trace.
					<DashboardLayout.Title title={rootSpan.spanName}>
						{rootSpan.spanName ?? "Unknown Trace"}
					</DashboardLayout.Title>
				)
			}}
			headerActions={({ data, traceStartTime, rootSpan }) =>
				rootSpan ? (
					<div className="flex items-center gap-2">
						<TraceLogsLink
							traceId={traceId}
							traceStartTime={traceStartTime}
							totalDurationMs={data.totalDurationMs}
						/>
						<TraceReplayLink traceId={traceId} />
					</div>
				) : undefined
			}
		>
			{({ data, traceStartTime, rootSpan }) =>
				rootSpan ? (
					<TraceDetailBody
						data={data}
						traceStartTime={traceStartTime}
						traceId={traceId}
						rootSpan={rootSpan}
					/>
				) : (
					<TraceNotFound
						traceId={traceId}
						backToTracesHref={backToTracesHref}
						title="Root span missing"
						description="This trace contains spans but the root span was not found. It may not have been ingested yet or could have been dropped during sampling."
					/>
				)
			}
		</ResultPage>
	)
}

function TraceDetailLoading() {
	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Skeleton className="h-8 w-32" />
				<Skeleton className="h-1.5 w-full rounded-full" />
				<div className="flex gap-4">
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-4 w-24" />
				</div>
			</div>
			<SkeletonList
				rows={5}
				gap="px"
				className="gap-0 rounded-md border"
				renderRow={() => (
					<div className="flex items-center gap-2 border-b p-3">
						<Skeleton className="size-4" />
						<Skeleton className="h-4 w-20" />
						<Skeleton className="h-4 w-16" />
						<Skeleton className="h-4 flex-1" />
						<Skeleton className="h-2 w-32" />
						<Skeleton className="h-4 w-16" />
					</div>
				)}
			/>
		</div>
	)
}

function TraceDetailBody({
	data,
	traceStartTime,
	traceId,
	rootSpan,
}: {
	data: SpanHierarchyResponse
	traceStartTime: string
	traceId: string
	rootSpan: SpanNode
}) {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const selectedSpan = React.useMemo(
		() => (search.spanId ? (findSpanById(data.rootSpans, search.spanId) ?? null) : null),
		[data.rootSpans, search.spanId],
	)

	const handleSelectSpan = React.useCallback(
		(span: SpanNode) => {
			if (search.spanId === span.spanId) return
			navigate({
				search: (prev: Record<string, unknown>) => ({ ...prev, spanId: span.spanId }),
				replace: true,
			})
		},
		[search.spanId, navigate],
	)

	// The product-events panel knows a span id, not a `SpanNode`.
	const handleSelectSpanId = React.useCallback(
		(spanId: string) => {
			if (search.spanId === spanId) return
			navigate({
				search: (prev: Record<string, unknown>) => ({ ...prev, spanId }),
				replace: true,
			})
		},
		[search.spanId, navigate],
	)

	const handleCloseSpanDetails = React.useCallback(() => {
		navigate({
			search: (prev: Record<string, unknown>) => ({ ...prev, spanId: undefined }),
			replace: true,
		})
	}, [navigate])

	// Esc closes the inline span panel; while the nested log sheet is open the
	// dialog guard defers to it, so Esc closes the sheet first.
	useAppHotkey("list.clear", handleCloseSpanDetails, { enabled: selectedSpan !== null })

	const services = React.useMemo(
		() => [...new Set(data.spans.map((s: Span) => s.serviceName))],
		[data.spans],
	)

	const isMobile = useIsMobile()

	// Shared by both layouts below so the tabs keep their state across a breakpoint change.
	const traceViewTabs = (
		<TraceViewTabs
			rootSpans={data.rootSpans}
			spans={data.spans}
			totalDurationMs={data.totalDurationMs}
			traceStartTime={traceStartTime}
			services={services}
			selectedSpanId={selectedSpan?.spanId}
			onSelectSpan={handleSelectSpan}
		/>
	)

	const rootHttpInfo = getHttpInfo(rootSpan)
	const deploymentEnv =
		rootSpan.resourceAttributes?.["deployment.environment.name"] ||
		rootSpan.resourceAttributes?.["deployment.environment"]
	const commitSha = rootSpan.resourceAttributes?.["vcs.ref.head.revision"]
	const hasError = data.spans.some((s: Span) => {
		if (s.statusCode === "Error") return true
		const httpStatus =
			s.spanAttributes?.["http.response.status_code"] || s.spanAttributes?.["http.status_code"]
		if (httpStatus) {
			const code = typeof httpStatus === "string" ? parseInt(httpStatus) : httpStatus
			if (typeof code === "number" && httpStatusTone(code) === "crit") return true
		}
		return false
	})

	return (
		<div className="flex flex-1 flex-col gap-y-3 min-h-0">
			<TraceAnatomyStrip
				spans={data.spans}
				totalDurationMs={data.totalDurationMs}
				traceId={traceId}
				hasError={hasError}
				httpStatusCode={rootHttpInfo?.statusCode}
				deploymentEnv={deploymentEnv}
				commitSha={commitSha}
			/>

			<TraceProductEvents
				traceId={traceId}
				traceStartTime={traceStartTime}
				totalDurationMs={data.totalDurationMs}
				onSelectSpan={handleSelectSpanId}
			/>

			{isMobile ? (
				// A 60/40 side-by-side split leaves each pane ~150px on a phone. Give the waterfall
				// the full width and float the span detail over it instead.
				<>
					<div className="flex-1 min-h-0 rounded-md border overflow-hidden">{traceViewTabs}</div>
					<Sheet
						open={selectedSpan != null}
						onOpenChange={(open) => {
							if (!open) handleCloseSpanDetails()
						}}
					>
						<SheetContent side="bottom" className="h-[80svh] p-0" showCloseButton={false}>
							<SheetHeader className="sr-only">
								<SheetTitle>Span details</SheetTitle>
								<SheetDescription>Details for the selected span.</SheetDescription>
							</SheetHeader>
							{selectedSpan && (
								<SpanDetailPanel
									span={selectedSpan}
									onClose={handleCloseSpanDetails}
									traceStartTime={traceStartTime}
									totalDurationMs={data.totalDurationMs}
								/>
							)}
						</SheetContent>
					</Sheet>
				</>
			) : (
				<ResizablePanelGroup
					orientation="horizontal"
					className="flex-1 min-h-0 rounded-md border overflow-hidden"
				>
					<ResizablePanel defaultSize={selectedSpan ? 60 : 100} minSize={40}>
						{traceViewTabs}
					</ResizablePanel>

					{selectedSpan && (
						<>
							<ResizableHandle withHandle />
							<ResizablePanel defaultSize={40} minSize={25}>
								<SpanDetailPanel
									span={selectedSpan}
									onClose={handleCloseSpanDetails}
									traceStartTime={traceStartTime}
									totalDurationMs={data.totalDurationMs}
								/>
							</ResizablePanel>
						</>
					)}
				</ResizablePanelGroup>
			)}
		</div>
	)
}

/** Not-found body, shared by "no such trace" and "root span missing". */
function TraceNotFound({
	traceId,
	backToTracesHref,
	title,
	description,
	footer,
}: {
	traceId: string
	backToTracesHref: string
	title: string
	description: string
	footer?: React.ReactNode
}) {
	return (
		<ResourceNotFound
			title={title}
			description={
				<div className="flex flex-col items-center gap-3">
					<TraceIdBadge traceId={traceId} />
					<p className="max-w-md">{description}</p>
					{footer}
				</div>
			}
			backLink={<a href={backToTracesHref} />}
			backLabel="Back to Traces"
		/>
	)
}
