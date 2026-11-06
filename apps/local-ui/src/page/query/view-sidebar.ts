import { EXAMPLE_QUERIES, tablePreviewSql } from "../../lib/query-console"
import { formatNumber } from "@maple/ui/lib/format"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { cn } from "@maple/ui/lib/utils"
import { filterSidebarBody, filterSidebarHeader } from "@maple/views/ui/filters/filter-sidebar"
import { icon } from "@maple/views/ui/icon"
import { pressable } from "@maple/views/ui/pressable"
import { hstackClass } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { spinner } from "@maple/views/ui/spinner"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isAwaitingFirstData } from "@maple/views/data/keyed"
import { filterRailFrame } from "../kit/filter-rail"
import { Message } from "./message"
import type { Model } from "./model"

// The Query page's sidebar: the tables and the starter queries.

const sidebarItem = (
	h: HtmlBuilder<Message>,
	title: string,
	sql: string,
	children: ReadonlyArray<Html>,
): Html =>
	pressable(
		h,
		{
			onClick: Message.ClickedPickSql({ sql }),
			className: cn(
				hstackClass({ gap: "2" }),
				"w-full rounded-md px-2 py-1 text-left text-xs hover:bg-accent/60 active:bg-accent/60",
			),
			attributes: [h.Title(title)],
		},
		children,
	)

const tablesList = (h: HtmlBuilder<Message>, model: Model): Html => {
	if (isAwaitingFirstData(model.tables))
		return h.div([h.Class("flex h-12 items-center justify-center")], [spinner(h, "size-4")])
	const failure = failureWithoutData(model.tables)
	if (Option.isSome(failure))
		return typography(h, { as: "p", size: "xs", className: "break-all text-destructive" }, [
			failure.value.message,
		])
	const tables = Option.getOrElse(AsyncData.getData(model.tables.data), () => [])
	return h.ul(
		[h.Class("space-y-0.5")],
		Arr.map(tables, (table) =>
			h.li(
				[h.Key(table.name)],
				[
					sidebarItem(h, `Insert SELECT * FROM ${table.name}`, tablePreviewSql(table.name), [
						icon(h, "DatabaseIcon", { className: "size-3.5 shrink-0 text-muted-foreground" }),
						typography(h, { mono: true, truncate: true, className: "min-w-0 flex-1" }, [
							table.name,
						]),
						...(table.totalRows !== null
							? [
									typography(h, { tone: "muted", numeric: true, className: "shrink-0" }, [
										formatNumber(table.totalRows),
									]),
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
	return filterRailFrame(h, { isWaiting: isFetching }, [
		filterSidebarHeader(h, { title: "Tables" }),
		...filterSidebarBody(h, "query-tables", [
			tablesList(h, model),
			eyebrow(h, { as: "h3", variant: "label", className: "pt-4 pb-1" }, ["Examples"]),
			h.ul(
				[h.Class("space-y-0.5")],
				Arr.map(EXAMPLE_QUERIES, (example) =>
					h.li(
						[h.Key(example.label)],
						[
							sidebarItem(h, example.sql, example.sql, [
								icon(h, "CodeIcon", { className: "size-3.5 shrink-0 text-muted-foreground" }),
								typography(h, { truncate: true, className: "min-w-0 flex-1" }, [
									example.label,
								]),
							]),
						],
					),
				),
			),
		]),
	])
}
