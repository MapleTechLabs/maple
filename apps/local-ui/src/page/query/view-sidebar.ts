import { EXAMPLE_QUERIES, tablePreviewSql } from "../../lib/query-console"
import { formatNumber } from "@maple/ui/lib/format"
import { eyebrow } from "@maple/web/ui/eyebrow"
import {
	filterSidebarBody,
	filterSidebarFrame,
	filterSidebarHeader,
} from "@maple/web/ui/filters/filter-sidebar"
import { icon } from "@maple/web/ui/icon"
import { spinner } from "@maple/web/ui/spinner"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { Message } from "./message"
import type { Model } from "./model"

// The Query page's sidebar: the tables and the starter queries.

const sidebarItem = (
	h: HtmlBuilder<Message>,
	title: string,
	sql: string,
	children: ReadonlyArray<Html>,
): Html =>
	h.button(
		[
			h.Type("button"),
			h.Title(title),
			h.OnClick(Message.ClickedPickSql({ sql })),
			h.Class(
				"flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent/60",
			),
		],
		children,
	)

const tablesList = (h: HtmlBuilder<Message>, model: Model): Html => {
	if (isPending(model.tables))
		return h.div([h.Class("flex h-12 items-center justify-center")], [spinner(h, "size-4")])
	const failure = failureWithoutData(model.tables)
	if (Option.isSome(failure))
		return h.p([h.Class("text-xs break-all text-destructive")], [failure.value.message])
	const tables = Option.getOrElse(AsyncData.getData(model.tables.data), () => [])
	return h.ul(
		[h.Class("space-y-0.5")],
		tables.map((table) =>
			h.li(
				[h.Key(table.name)],
				[
					sidebarItem(h, `Insert SELECT * FROM ${table.name}`, tablePreviewSql(table.name), [
						icon(h, "DatabaseIcon", { className: "size-3.5 shrink-0 text-muted-foreground" }),
						h.span([h.Class("min-w-0 flex-1 truncate font-mono")], [table.name]),
						...(table.totalRows !== null
							? [
									h.span(
										[h.Class("shrink-0 tabular-nums text-muted-foreground")],
										[formatNumber(table.totalRows)],
									),
								]
							: []),
					]),
				],
			),
		),
	)
}

export const querySidebar = (h: HtmlBuilder<Message>, model: Model): Html => {
	const isFetching = AsyncData.isLoading(model.tables.data) || AsyncData.isRefreshing(model.tables.data)
	return filterSidebarFrame(h, { className: "w-56 shrink-0 px-4", isWaiting: isFetching }, [
		filterSidebarHeader(h, { title: "Tables" }),
		...filterSidebarBody(h, "query-tables", [
			tablesList(h, model),
			eyebrow(h, { as: "h3", variant: "label", className: "pt-4 pb-1" }, ["Examples"]),
			h.ul(
				[h.Class("space-y-0.5")],
				EXAMPLE_QUERIES.map((example) =>
					h.li(
						[h.Key(example.label)],
						[
							sidebarItem(h, example.sql, example.sql, [
								icon(h, "CodeIcon", { className: "size-3.5 shrink-0 text-muted-foreground" }),
								h.span([h.Class("min-w-0 flex-1 truncate")], [example.label]),
							]),
						],
					),
				),
			),
		]),
	])
}
