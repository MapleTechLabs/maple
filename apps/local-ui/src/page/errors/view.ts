import { formatErrorRate } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { icon } from "@maple/web/ui/icon"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { queryOf } from "../../route"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { pageShell } from "../kit/page-shell"
import { signalEmptyState } from "../kit/signal-empty-state"
import { refreshButton, timeRangeSelect, toolbar, toolbarStat, toolbarStats } from "../kit/toolbar"
import { emptyState, errorState, listSkeleton } from "../kit/view-states"
import { errorsFiltersOf } from "./command"
import { cardOf } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { errorTypeCard } from "./view-card"
import { sidebar } from "./view-sidebar"

// The Errors page: error types grouped by fingerprint, with filters.

const toCopy = (id: string, message: Parameters<typeof Message.GotCopyMessage>[0]["message"]) =>
	Message.GotCopyMessage({ id, message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const { context } = inputs
	const query = queryOf(context.location)
	const filters = errorsFiltersOf(query)
	const range = rangeOf(context)
	const activeFilterCount = [filters.service, filters.env, filters.rootOnly].filter(Boolean).length
	const stats = Option.getOrNull(
		Option.flatMap(AsyncData.getData(model.summary.data), Option.fromNullishOr),
	)
	const rows = Option.getOrElse(AsyncData.getData(model.byType.data), () => [])
	const tracesPresence = inputs.presenceOf("traces")
	const content = (): Html => {
		if (isPending(model.byType)) return listSkeleton(h, { variant: "card", rows: 6 })
		const failure = failureWithoutData(model.byType)
		if (Option.isSome(failure))
			return errorState(h, {
				label: "errors",
				failure: failure.value,
				onRetry: Message.ClickedRefresh(),
			})
		if (rows.length === 0)
			return activeFilterCount === 0 &&
				Option.exists(tracesPresence, (presence) => presence.status === "present")
				? emptyState(h, {
						icon: icon(h, "CircleWarningIcon"),
						title: "No errors in this range",
						hint: [
							"Errors appear when spans arrive with an Error status. None did in the selected window.",
						],
					})
				: signalEmptyState(h, {
						signal: "traces",
						noun: "errors",
						isFiltered: activeFilterCount > 0,
						onClearFilters: Message.ClickedClearFilters(),
						range,
						onWidenRange: Message.ClickedWidenRange(),
						maybePresence: tracesPresence,
						nowMs: inputs.presenceNowMs,
						guide: {
							id: "errors-empty",
							endpoint: context.env.otlpEndpoint,
							copies: model.copies,
							toCopyMessage: toCopy,
						},
					})
		return h.div(
			[h.Class(cn("space-y-2 p-4", model.byType.isPlaceholder && "opacity-60 transition-opacity"))],
			rows.map((row) =>
				errorTypeCard(
					h,
					row,
					cardOf(model, row.fingerprintHash),
					query,
					Math.max(model.nowMs, inputs.clockMs),
				),
			),
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
						toolbarStat(h, {
							value: Math.round(stats?.totalErrors ?? 0),
							label: "errors",
							isDanger: true,
						}),
						toolbarStat(h, {
							value: Math.round(stats?.affectedTracesCount ?? 0),
							label: "affected traces",
						}),
						h.span(
							[h.Class("text-sm whitespace-nowrap text-muted-foreground")],
							[
								h.span(
									[h.Class("font-medium tabular-nums text-foreground")],
									[formatErrorRate(stats?.errorRate ?? 0)],
								),
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
							hasNewData: inputs.hasNewDataSince(model.byTypeUpdatedAtMs),
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
