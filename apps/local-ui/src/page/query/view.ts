import { formatElapsed } from "../../lib/query-console"
import { button } from "@maple/web/ui/button"
import { kbd } from "@maple/web/ui/display"
import { icon } from "@maple/web/ui/icon"
import { spinner } from "@maple/web/ui/spinner"
import { textarea } from "@maple/web/ui/textarea"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { queryOf } from "../../route"
import type { PageContext } from "../contract"
import { pageShell } from "../kit/page-shell"
import { toolbar, toolbarStat, toolbarStats } from "../kit/toolbar"
import { emptyState } from "../kit/view-states"
import { QueryComposition } from "./composition"
import { Message } from "./message"
import { type Model, RunState } from "./model"
import { queryError, resultTable } from "./view-result"
import { querySidebar } from "./view-sidebar"

// The Query page: a SQL console over the local store.

const rowsOf = (model: Model) => (model.run._tag === "Succeeded" ? model.run.rows : [])

const consoleToolbar = (h: HtmlBuilder<Message>, model: Model): Html => {
	const rows = rowsOf(model)
	const download = (format: "Csv" | "Json", label: string) =>
		button(
			h,
			{ variant: "outline", size: "sm", isDisabled: rows.length === 0, attributes: [h.OnClick(Message.ClickedDownload({ format }))] },
			[label],
		)
	return toolbar(h, [
		toolbarStats(
			h,
			model.run._tag === "Succeeded"
				? [
						toolbarStat(h, { value: rows.length, label: rows.length === 1 ? "row" : "rows" }),
						h.span(
							[h.Class("text-sm whitespace-nowrap text-muted-foreground")],
							[h.span([h.Class("font-medium tabular-nums text-foreground")], [formatElapsed(model.run.elapsedMs)]), " ", "elapsed"],
						),
					]
				: [h.span([h.Class("text-sm text-muted-foreground")], ["Read-only SQL against the local chDB tables"])],
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
						key === "Enter" && (modifiers.metaKey || modifiers.ctrlKey) ? Option.some(Message.ClickedRun()) : Option.none(),
					),
				],
			}),
			h.div(
				[h.Class("flex items-center justify-between gap-2")],
				[
					h.span(
						[h.Class("flex items-center gap-1 text-xs text-muted-foreground")],
						[kbd(h, undefined, [model.isMac ? "⌘" : "Ctrl"]), kbd(h, undefined, ["Enter"]), h.span([h.Class("ml-1")], ["to run"])],
					),
					model.run._tag === "Running"
						? button(h, { variant: "outline", size: "sm", className: "gap-1.5", attributes: [h.OnClick(Message.ClickedCancel())] }, [
								spinner(h, "size-3.5"),
								"Cancel",
							])
						: button(h, { size: "sm", isDisabled: sql.trim() === "", attributes: [h.OnClick(Message.ClickedRun())] }, ["Run"]),
				],
			),
		],
	)

const result = (h: HtmlBuilder<Message>, model: Model): Html =>
	RunState.match(model.run, {
		Idle: () =>
			emptyState(h, {
				icon: icon(h, "CodeIcon"),
				title: "Run a query",
				hint: ["Pick a table or an example from the sidebar, or write your own SELECT. Every table is scoped by OrgId = 'local'."],
			}),
		Running: () => h.div([h.Class("flex h-24 items-center justify-center")], [spinner(h, "size-4")]),
		Failed: ({ title, detail }) => queryError(h, title, detail),
		Succeeded: ({ rows }) =>
			rows.length === 0
				? emptyState(h, { title: "No rows", hint: ["The query ran and returned an empty result."] })
				: resultTable(h, rows),
	})

/** What the view reads from the root: data only, as Block view inputs carry no callbacks. */
export type QueryViewInputs = Readonly<{ context: PageContext }>

export const view = QueryComposition.makeView.withInputs<QueryViewInputs>((model, inputs, h) => {
	const sql = queryOf(inputs.context.location).get("sql") ?? ""
	return pageShell(h, { sidebar: querySidebar(h, model), toolbar: consoleToolbar(h, model), onOpenFilters: Message.ClickedOpenFilters() }, [
		h.div(
			[h.Class("flex h-full min-h-0 flex-col")],
			[editor(h, model, sql), h.div([h.Class("min-h-0 flex-1 overflow-auto")], [result(h, model)])],
		),
	])
})
