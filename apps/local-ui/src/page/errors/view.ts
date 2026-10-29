import { formatErrorRate } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { icon } from "@maple/web/ui/icon"
import { Option } from "effect"
import * as CopyButton from "@maple/web/ui/copy-button"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { queryOf } from "../../route"
import { type PresenceResult, presenceOf } from "../../data/signal-presence"
import { type PageContext, rangeOf } from "../contract"
import { pageShell } from "../kit/page-shell"
import { signalEmptyState } from "../kit/signal-empty-state"
import { refreshButton, timeRangeSelect, toolbar, toolbarStat, toolbarStats } from "../kit/toolbar"
import { emptyState, errorState, listSkeleton } from "../kit/view-states"
import { errorsFiltersOf } from "./command"
import { cardOf } from "./load"
import { ErrorsComposition, type ErrorsViewBuilder, GuideEndpointCopyBinding, GuideEnvCopyBinding } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { errorTypeCard } from "./view-card"
import { sidebar } from "./view-sidebar"

// The Errors page: error types grouped by fingerprint, with filters.

/** What the view reads from the root: data only, as Block view inputs carry no callbacks. */
export type ErrorsViewInputs = Readonly<{
	context: PageContext
	/** The root's latest clock read (each server probe): legacy's per-render `Date.now()` for relative times. */
	clockMs: number
	/** The server's last ingest, for `useNewDataSince`'s "New data" pill. */
	lastIngestAtMs: Option.Option<number>
	/** The shared signal presence read; none while loading or unreadable. */
	maybePresence: Option.Option<PresenceResult>
}>

const GUIDE_ID = "errors-empty"

/** `useNewDataSince(sinceMs)`: telemetry arrived after the list loaded. */
const hasNewDataSince = (inputs: ErrorsViewInputs, sinceMs: number): boolean =>
	sinceMs > 0 && Option.exists(inputs.lastIngestAtMs, (last) => last > sinceMs)

/** The connect guide's two copy buttons, by the id the guide gives each. */
const embedGuideCopy =
	(h: ErrorsViewBuilder, model: Model) =>
	(copyId: string, viewInputs: CopyButton.CopyButtonViewInputs): Html =>
		copyId === `${GUIDE_ID}-endpoint`
			? h.block(GuideEndpointCopyBinding.embedView({ slotId: copyId, model: model.guideEndpointCopy, viewInputs }))
			: h.block(GuideEnvCopyBinding.embedView({ slotId: copyId, model: model.guideEnvCopy, viewInputs }))

export const view = ErrorsComposition.makeView.withInputs<ErrorsViewInputs>((model, inputs, h) => {
	const { context } = inputs
	const query = queryOf(context.location)
	const filters = errorsFiltersOf(query)
	const range = rangeOf(context)
	const activeFilterCount = [filters.service, filters.env, filters.rootOnly].filter(Boolean).length
	const stats = Option.getOrNull(Option.flatMap(AsyncData.getData(model.summary.data), Option.fromNullishOr))
	const rows = Option.getOrElse(AsyncData.getData(model.byType.data), () => [])
	const tracesPresence = presenceOf(inputs.maybePresence, "traces")
	const presenceNowMs = Option.match(inputs.maybePresence, { onNone: () => 0, onSome: (result) => result.nowMs })
	const content = (): Html => {
		if (isPending(model.byType)) return listSkeleton(h, { variant: "card", rows: 6 })
		const failure = failureWithoutData(model.byType)
		if (Option.isSome(failure))
			return errorState(h, { label: "errors", failure: failure.value, onRetry: Message.ClickedRefresh() })
		if (rows.length === 0)
			return activeFilterCount === 0 && Option.exists(tracesPresence, (presence) => presence.status === "present")
				? emptyState(h, {
						icon: icon(h, "CircleWarningIcon"),
						title: "No errors in this range",
						hint: ["Errors appear when spans arrive with an Error status. None did in the selected window."],
					})
				: signalEmptyState(h, {
						signal: "traces",
						noun: "errors",
						isFiltered: activeFilterCount > 0,
						onClearFilters: Message.ClickedClearFilters(),
						range,
						onWidenRange: Message.ClickedWidenRange(),
						maybePresence: tracesPresence,
						nowMs: presenceNowMs,
						guide: { id: GUIDE_ID, endpoint: context.env.otlpEndpoint, embedCopy: embedGuideCopy(h, model) },
					})
		return h.div(
			[h.Class(cn("space-y-2 p-4", model.byType.isPlaceholder && "opacity-60 transition-opacity"))],
			rows.map((row) => errorTypeCard(h, row, cardOf(model, row.fingerprintHash), query, Math.max(model.nowMs, inputs.clockMs))),
		)
	}
	return pageShell(
		h,
		{
			onOpenFilters: Message.ClickedOpenFilters(),
			sidebar: sidebar(h, model, filters, activeFilterCount),
			toolbar: toolbar(h, [
				toolbarStats(
					h,
					[
						toolbarStat(h, { value: Math.round(stats?.totalErrors ?? 0), label: "errors", isDanger: true }),
						toolbarStat(h, { value: Math.round(stats?.affectedTracesCount ?? 0), label: "affected traces" }),
						h.span(
							[h.Class("text-sm whitespace-nowrap text-muted-foreground")],
							[
								h.span([h.Class("font-medium tabular-nums text-foreground")], [formatErrorRate(stats?.errorRate ?? 0)]),
								" ",
								"error rate",
							],
						),
					],
					"flex-wrap",
				),
				toolbarStats(
					h,
					[
						refreshButton(h, {
							isSpinning: model.isRefreshing,
							hasNewData: hasNewDataSince(inputs, model.byTypeUpdatedAtMs),
							onRefresh: Message.ClickedRefresh(),
						}),
						timeRangeSelect(h, range, (next) => Message.ChangedRange({ range: next })),
					],
					"shrink-0",
				),
			]),
			activeFilterCount,
		},
		[content()],
	)
})
