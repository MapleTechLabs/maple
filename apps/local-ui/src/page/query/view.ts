import { formatElapsed } from "../../lib/query-console"
import { button } from "@maple/views/ui/button"
import { kbd } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { spinner } from "@maple/views/ui/spinner"
import { textarea } from "@maple/views/ui/textarea"
import { Option, String as Str } from "effect"
import { Submodel } from "foldkit"
import { scrollRegion } from "@maple/views/ui/scroll-region"
import type { Html, HtmlBuilder } from "foldkit/html"
import { queryOf } from "../../route"
import type { PageViewInputs } from "../kit/inputs"
import { pageShell } from "../kit/page-shell"
import { emptyNotice } from "../kit/placeholders"
import { toolbar, toolbarStat, toolbarStats } from "../kit/toolbar"
import { Message } from "./message"
import { type Model, RunState } from "./model"
import { queryError, resultTable } from "./view-result"
import { querySidebar } from "./view-sidebar"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography, typographyClass } from "@maple/views/ui/typography"

// The Query page: a SQL console over the local store.

const rowsOf = (model: Model) => (model.run._tag === "Succeeded" ? model.run.rows : [])

const consoleToolbar = (h: HtmlBuilder<Message>, model: Model): Html => {
	const rows = rowsOf(model)
	const download = (format: "Csv" | "Json", label: string) =>
		button(
			h,
			{
				variant: "outline",
				size: "sm",
				isDisabled: rows.length === 0,
				attributes: [h.OnClick(Message.ClickedDownload({ format }))],
			},
			[label],
		)
	return toolbar(h, [
		toolbarStats(
			h,
			model.run._tag === "Succeeded"
				? [
						toolbarStat(h, { value: rows.length, label: rows.length === 1 ? "row" : "rows" }),
						typography(h, { size: "sm", tone: "muted", className: "whitespace-nowrap" }, [
							typography(h, { weight: "medium", tone: "foreground", numeric: true }, [
								formatElapsed(model.run.elapsedMs),
							]),
							" ",
							"elapsed",
						]),
					]
				: [
						typography(h, { size: "sm", tone: "muted" }, [
							"Read-only SQL against the local chDB tables",
						]),
					],
			"flex-wrap",
		),
		toolbarStats(h, [download("Csv", "CSV"), download("Json", "JSON")], "shrink-0 gap-2"),
	])
}

const editor = (h: HtmlBuilder<Message>, model: Model, sql: string): Html =>
	h.div(
		[h.Class("space-y-2 border-b p-4")],
		[
			textarea(h, {
				id: "query-console-sql",
				controlClassName: "max-h-72 min-h-28 font-mono text-xs leading-relaxed",
				defaultValue: sql,
				attributes: [
					h.AriaLabel("SQL query"),
					h.Placeholder("SELECT * FROM traces WHERE OrgId = 'local' LIMIT 100"),
					h.Spellcheck(false),
					h.OnInput((text) => Message.ChangedSql({ text })),
					h.OnKeyDownPreventDefault((key, modifiers) =>
						key === "Enter" && (modifiers.metaKey || modifiers.ctrlKey)
							? Option.some(Message.ClickedRun())
							: Option.none(),
					),
				],
			}),
			hstack(h, { gap: "2", justify: "between" }, [
				hstack(
					h,
					{ as: "span", gap: "1", className: typographyClass({ size: "xs", tone: "muted" }) },
					[
						kbd(h, undefined, [model.isMac ? "⌘" : "Ctrl"]),
						kbd(h, undefined, ["Enter"]),
						h.span([h.Class("ml-1")], ["to run"]),
					],
				),
				model.run._tag === "Running"
					? button(
							h,
							{
								variant: "outline",
								size: "sm",
								className: "gap-1.5",
								attributes: [h.OnClick(Message.ClickedCancel())],
							},
							[spinner(h, "size-3.5"), "Cancel"],
						)
					: button(
							h,
							{
								size: "sm",
								isDisabled: Str.trim(sql) === "",
								attributes: [h.OnClick(Message.ClickedRun())],
							},
							["Run"],
						),
			]),
		],
	)

const result = (h: HtmlBuilder<Message>, model: Model): Html =>
	RunState.match(model.run, {
		Idle: () =>
			emptyNotice(h, {
				icon: icon(h, "CodeIcon"),
				title: "Run a query",
				hint: "Pick a table or an example from the sidebar, or write your own SELECT. Every table is scoped by OrgId = 'local'.",
			}),
		Running: () =>
			hstack(h, { align: "center", justify: "center", className: "h-24" }, [spinner(h, "size-4")]),
		Failed: ({ title, detail }) => queryError(h, title, detail),
		Succeeded: ({ rows }) =>
			rows.length === 0
				? emptyNotice(h, { title: "No rows", hint: "The query ran and returned an empty result." })
				: resultTable(h, rows),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const sql = queryOf(inputs.context.location).get("sql") ?? ""
	return pageShell(
		h,
		{
			sidebar: querySidebar(h, model),
			toolbar: consoleToolbar(h, model),
			onOpenFilters: Message.ClickedOpenFilters(),
		},
		[
			vstack(h, { className: "h-full min-h-0" }, [
				editor(h, model, sql),
				scrollRegion(h, { className: "overflow-auto" }, [result(h, model)]),
			]),
		],
	)
})
