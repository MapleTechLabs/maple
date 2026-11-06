import { formatErrorRate } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { typography } from "@maple/views/ui/typography"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { failureWithoutData, isAwaitingFirstData } from "@maple/views/data/keyed"
import { queryOf } from "../../route"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { pageShell } from "../kit/page-shell"
import { emptyNotice, listSkeleton } from "../kit/placeholders"
import { signalEmptyState } from "../kit/signal-empty-state"
import { refreshButton, timeRangeSelect, toolbar, toolbarStat, toolbarStats } from "../kit/toolbar"
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
	const activeFilterCount = Arr.filter([filters.service, filters.env, filters.rootOnly], Boolean).length
	const stats = Option.getOrNull(
		Option.flatMap(AsyncData.getData(model.summary.data), Option.fromNullishOr),
	)
	const rows = Option.getOrElse(AsyncData.getData(model.byType.data), () => [])
	const tracesPresence = inputs.presenceOf("traces")
	const content = (): Html => {
		if (isAwaitingFirstData(model.byType)) return listSkeleton(h, "card", 6)
		const failure = failureWithoutData(model.byType)
		if (Option.isSome(failure))
			return errorState(h, {
				failure: failure.value,
				title: "Couldn’t load errors",
				onRetry: Message.ClickedRefresh(),
			})
		if (rows.length === 0)
			return activeFilterCount === 0 && tracesPresence.status === "present"
				? emptyNotice(h, {
						icon: icon(h, "CircleWarningIcon"),
						title: "No errors in this range",
						hint: "Errors appear when spans arrive with an Error status. None did in the selected window.",
					})
				: signalEmptyState(h, {
						signal: "traces",
						noun: "errors",
						isFiltered: activeFilterCount > 0,
						onClearFilters: Message.ClickedClearFilters(),
						range,
						onWidenRange: Message.ClickedWidenRange(),
						presence: tracesPresence,
						nowMs: inputs.presenceNowMs,
						timeZone: inputs.context.timeFormat.timeZone,
						guide: {
							id: "errors-empty",
							endpoint: context.env.otlpEndpoint,
							copies: model.copies,
							toCopyMessage: toCopy,
						},
					})
		return h.div(
			[h.Class(cn("space-y-2 p-4", model.byType.retained === true && "opacity-60 transition-opacity"))],
			Arr.map(rows, (row) =>
				errorTypeCard(h, row, cardOf(model, row.fingerprintHash), query, {
					nowMs: Math.max(model.nowMs, inputs.clockMs),
					timeZone: context.timeFormat.timeZone,
				}),
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
						typography(h, { size: "sm", tone: "muted", className: "whitespace-nowrap" }, [
							typography(h, { tone: "foreground", weight: "medium", numeric: true }, [
								formatErrorRate(stats?.errorRate ?? 0),
							]),
							" ",
							"error rate",
						]),
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
