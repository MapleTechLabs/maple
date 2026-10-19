import type { V2Source } from "@maple/domain/http/v2"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { skeleton } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { platformMeta, platformTile } from "../kit/platforms"
import { orderSources, sourceHref } from "../kit/shared"
import { sourceStatusBadge } from "../kit/status"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

// The whole row opens on click; the name is the real link for keyboards and screen readers.
const NAME_LINK_CLASS = "truncate text-sm font-medium outline-none hover:underline focus-visible:underline"

const connectButton = (h: H): Html =>
	linkButton(h, { size: "sm", href: "/sources/new" }, [
		icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
		"Connect source",
	])

const tokenLabel = (source: V2Source): string =>
	source.key_prefix === null ? (source.is_default ? "Org ingest keys" : "-") : `${source.key_prefix}…`

const sourceRow = (h: H, source: V2Source, nowMs: number): Html => {
	const href = sourceHref(source)
	return tableRow(
		h,
		[
			tableCell(h, [
				h.div(
					[h.Class("flex min-w-0 items-center gap-3")],
					[
						platformTile(h, source.platform, "sm"),
						h.div(
							[h.Class("flex min-w-0 flex-col gap-0.5")],
							[
								h.a(
									[
										h.Href(href),
										h.Class(NAME_LINK_CLASS),
										h.OnClick(Message.ClickedSource({ url: href }), {
											defaultAction: "Prevent",
											propagation: "Stop",
										}),
									],
									[source.name],
								),
								h.span(
									[h.Class("text-muted-foreground truncate text-xs")],
									[`${platformMeta(source.platform).label}${source.is_default ? " · Default" : ""}`],
								),
							],
						),
					],
				),
			]),
			tableCell(h, [sourceStatusBadge(h, source, { nowMs, showTime: false })]),
			tableCell(
				h,
				[source.health.last_data_at === null ? "Never" : formatRelativeTime(source.health.last_data_at, nowMs)],
				"text-muted-foreground hidden sm:table-cell",
			),
			tableCell(h, [tokenLabel(source)], "text-muted-foreground hidden truncate font-mono text-xs sm:table-cell"),
			tableCell(h, [icon(h, "ChevronRightIcon", { size: 14, className: "text-muted-foreground" })]),
		],
		"cursor-pointer",
		[h.Key(source.id), h.OnClick(Message.ClickedSource({ url: href }))],
	)
}

const emptyState = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "ConnectionIcon", { size: 16 })]),
				emptyTitle(h, ["Connect your first source"]),
				emptyDescription(h, [
					"Give each SDK, cluster or host its own source to see what it sends, cap its rate, or pause it on its own.",
				]),
			]),
			connectButton(h),
		],
		"py-8",
	)

const sourcesTable = (h: H, rows: ReadonlyArray<V2Source>, nowMs: number): Html => {
	const sources = orderSources(rows)
	const added = sources.filter((source) => !source.is_default)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			table(h, { variant: "card", className: "table-fixed" }, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, ["Source"]),
						tableHead(h, ["Status"], "w-36 sm:w-48"),
						tableHead(h, ["Last data"], "hidden w-28 sm:table-cell"),
						tableHead(h, ["Token"], "hidden w-44 sm:table-cell"),
						tableHead(h, [], "w-10"),
					]),
				]),
				tableBody(h, sources.map((source) => sourceRow(h, source, nowMs))),
			]),
			...(added.length === 0 ? [emptyState(h)] : []),
		],
	)
}

const failed = (h: H, failure: Parameters<typeof errorState>[1]["failure"]): Html =>
	errorState(h, { failure, title: "Couldn't load sources", onRetry: Message.ClickedRetry() })

const body = (h: H, model: Model): Html => {
	const loading = skeleton(h, "h-48 w-full")
	const nowMs = model.nowMs
	if (nowMs === null) return loading
	return AsyncData.match(model.list.data, {
		onIdle: () => loading,
		onLoading: () => loading,
		onFailure: (failure) => failed(h, failure),
		onStale: ({ error }) => failed(h, error),
		onSuccess: (rows) => sourcesTable(h, rows, nowMs),
		onRefreshing: (rows) => sourcesTable(h, rows, nowMs),
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
	dashboardPage(h, { actions: connectButton(h) }, [body(h, model)]),
)
