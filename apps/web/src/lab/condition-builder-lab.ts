import { createQueryDraft, resetQueryForDataSource } from "@maple/query-engine/query-builder"
import { Option, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { typography } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"
import type { WhereClauseAutocompleteValues } from "../lib/query-builder/where-clause-autocomplete"
import type { Resources } from "../platform/resources"
import { sectionHeading } from "../page/kit/section-heading"
import { applyQueryChange } from "../page/kit/query-builder/change"
import { QueryDraft } from "../page/kit/query-builder/draft"
import * as QueryPanel from "../page/kit/query-builder/panel"
import { queryPanelView } from "../page/kit/query-builder/view"

// `/lab/condition-builder`: the query panel's where clause as condition rows, over fixture
// vocabulary: empty, populated, clauses the rows can't show, and the text editor.

export const LAB_VALUES: WhereClauseAutocompleteValues = {
	services: ["checkout", "api", "payments", "frontend"],
	spanNames: ["GET /api/cart", "POST /api/checkout", "db.query"],
	environments: ["production", "staging"],
	severities: ["ERROR", "WARN", "INFO", "DEBUG"],
	httpStatusCodes: ["200", "404", "500", "503"],
	attributeKeys: [
		"http.route",
		"http.request.method",
		"http.response.status_code",
		"db.system",
		"messaging.destination.partition.id",
		"service.version",
	],
	// `service.version` is in both groups: its trigger names the group.
	resourceAttributeKeys: ["host.name", "k8s.pod.name", "cloud.region", "service.version"],
}

type Scenario = Readonly<{ title: string; hint: string; query: QueryDraft }>

const draft = (id: string, name: string, dataSource: "traces" | "logs", whereClause: string): QueryDraft => ({
	...resetQueryForDataSource({ ...createQueryDraft(0), id, name }, dataSource),
	whereClause,
})

export const SCENARIOS: ReadonlyArray<Scenario> = [
	{ title: "Empty", hint: "No conditions yet.", query: draft("empty", "A", "traces", "") },
	{
		title: "Populated",
		hint: "An attribute row with several values matches any of them; rows are AND-ed.",
		query: draft(
			"populated",
			"B",
			"traces",
			'service.name = "checkout" AND (attr.http.request.method = "GET" OR attr.http.request.method = "POST") AND resource.service.version exists AND attr.messaging.destination.partition.id = "12"',
		),
	},
	{
		title: "Can't show as rows",
		hint: "An OR across different fields stays in the text editor.",
		query: draft(
			"unparseable",
			"C",
			"traces",
			'(attr.http.route = "/cart" OR attr.rpc.method = "Checkout")',
		),
	},
	{
		title: "OR group the query drops",
		hint: "A named field can't be OR-ed: the filter stays in Text, and the warning names the group the query drops.",
		query: draft(
			"dropped",
			"E",
			"traces",
			'(service.name = "checkout" OR service.name = "worker") AND attr.http.route exists',
		),
	},
	{
		title: "Text mode",
		hint: "Switched to Text by hand.",
		query: draft("text", "D", "logs", 'service.name = "checkout" AND severity = "ERROR"'),
	},
]

export const Model = Schema.Struct({ panel: QueryPanel.Model, queries: Schema.Array(QueryDraft) })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotPanelMessage: { message: QueryPanel.Message } })
export type Message = typeof Message.Type

export const init = (): Update.Return<Model, Message> => {
	const panel = QueryPanel.init("condition-lab")
	return {
		model: {
			panel: { ...panel, whereModes: { text: "text" } },
			queries: Arr.map(SCENARIOS, (scenario) => scenario.query),
		},
	}
}

export const panelInputs = (queries: ReadonlyArray<QueryDraft>): QueryPanel.PanelInputs => ({
	queryOf: (queryId) => Option.getOrUndefined(Arr.findFirst(queries, (query) => query.id === queryId)),
	baseValuesOf: () => LAB_VALUES,
	orgId: "org_lab",
	window: null,
})

/** The host's half: the panel's query edits land on the drafts. */
export const update = (model: Model, message: Message): Update.Return<Model, Message, Resources> => {
	const next = QueryPanel.update(model.panel, message.message, panelInputs(model.queries))
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotPanelMessage({ message: inner }),
	)
	const out = next.outMessage
	const queries =
		out?._tag === "ChangedQuery"
			? Arr.map(model.queries, (query) =>
					query.id === out.queryId ? applyQueryChange(query, out.change) : query,
				)
			: model.queries
	return { model: { panel: next.model, queries }, commands }
}

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	// As wide as the alert editor gives the panel, so rows lay out as they do there.
	vstack(h, { gap: "8", className: "mx-auto w-full max-w-5xl p-4 sm:p-6" }, [
		vstack(h, { gap: "1" }, [
			sectionHeading(h, { title: "Condition builder" }),
			typography(h, { size: "sm", tone: "muted", as: "p" }, [
				"The where clause as rows. Every edit prints the same string the text editor writes.",
			]),
		]),
		...Arr.map(model.queries, (query, index) => {
			const scenario = SCENARIOS[index]
			return vstack(h, { gap: "2", as: "section", attributes: [h.Key(query.id)] }, [
				sectionHeading(h, { title: scenario?.title ?? query.name, hint: scenario?.hint, as: "h3" }),
				h.submodel({
					slotId: `condition-lab-${query.id}`,
					model: model.panel,
					view: queryPanelView,
					toParentMessage: (message) => Message.GotPanelMessage({ message }),
					viewInputs: {
						query,
						index,
						canRemove: false,
						intervalPlaceholder: "Auto",
						hasHeaderActions: false,
						hasVisibilityToggle: false,
						autocompleteValues: LAB_VALUES,
					},
				}),
				typography(h, { size: "2xs", tone: "subtle", mono: true, as: "p", className: "break-all" }, [
					query.whereClause === "" ? "(empty where clause)" : query.whereClause,
				]),
			])
		}),
	])
