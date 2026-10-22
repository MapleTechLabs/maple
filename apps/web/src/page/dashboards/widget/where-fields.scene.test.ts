import { OrgId } from "@maple/domain"
import type { FunnelPopulationFilterField } from "@maple/query-model"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { CaretMessage } from "../../kit/where-autocomplete"
import { WhereFieldMessage } from "../../kit/where-field"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./page-update"
import { ProductEdit, type StepScope } from "./product-edit"
import { init } from "./update"
import { LIST_FILTER_ID, populationFilterId, stepFilterId } from "./where-fields"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const anchor = { left: 0, top: 0, bottom: 32, width: 400, viewportHeight: 900 }
const COUNTRY: FunnelPopulationFilterField = "country"

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_platform",
	name: "Platform overview",
	timeRange: { type: "relative", value: "6h" },
	widgets: [
		{
			id: "throughput",
			visualization: "chart",
			dataSource: {
				kind: "query",
				resultShape: "timeseries",
				queries: [{ id: "q1", name: "A", dataSource: "traces", aggregation: "count", whereClause: "" }],
			},
			display: { title: "Throughput", chartId: "query-builder-line" },
			layout: { x: 0, y: 0, w: 6, h: 6 },
		},
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

type Command = Readonly<{ name: string; args?: Readonly<Record<string, unknown>> }>
type Step = Readonly<{ model: Model; commands: ReadonlyArray<Command> }>

const run = (step: Step, ...messages: ReadonlyArray<Message>): Step =>
	messages.reduce<Step>((current, message) => {
		const next = update(current.model, message, context)
		return { model: next.model, commands: [...current.commands, ...(next.commands ?? [])] }
	}, step)

const opened = (...messages: ReadonlyArray<Message>): Step =>
	run(
		{ model: init({ dashboardId: "dash_platform", widgetId: "throughput", search: {} }, context).model, commands: [] },
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		...messages,
	)

const field = (message: WhereFieldMessage) => Message.GotWhereFieldMessage({ message })
const edit = (change: ProductEdit) => Message.ChangedProduct({ edit: change })
const names = (step: Step) => step.commands.map(({ name }) => name)
const fresh = (step: Step): Step => ({ model: step.model, commands: [] })

/** Focus `fieldId`, type `text` through `toEdit`, the caret at its end. */
const typed = (step: Step, fieldId: string, text: string, toEdit: (value: string) => ProductEdit): Step =>
	run(
		step,
		field(WhereFieldMessage.GotCaret({ fieldId, message: CaretMessage.FocusedEditor({ cursor: 0, anchor }) })),
		edit(toEdit(text)),
		field(WhereFieldMessage.GotCaret({ fieldId, message: CaretMessage.MovedCaret({ cursor: text.length, anchor, keyUp: null }) })),
	)

const listWhere = (value: string) => ProductEdit.ChangedListWhere({ value })
const population = (scope: StepScope) => (value: string) => ProductEdit.ChangedPopulationFilter({ scope, value })

/** The provider's traces facets answered with `services`. */
const servicesAnswered = (step: Step, services: ReadonlyArray<string>): Step =>
	run(
		step,
		Message.CompletedFetchAutocomplete({
			key: step.model.autocomplete.tracesFacets?.key ?? "",
			lookup: "tracesFacets",
			result: Result.succeed({ services }),
		}),
	)

/** The funnel suggestions' facets answered with `countries`. */
const countriesAnswered = (step: Step, countries: ReadonlyArray<string>): Step =>
	run(
		step,
		Message.CompletedFetchSuggestions({
			key: step.model.suggestions.facets?.key ?? "",
			lookup: "facets",
			result: Result.succeed(countries.map((name) => ({ name, count: null, field: COUNTRY }))),
		}),
	)

const accept = (fieldId: string) => [
	field(WhereFieldMessage.MovedSuggestion({ fieldId, step: 1 })),
	field(WhereFieldMessage.PressedEnter({ fieldId })),
]

describe("widget where fields", () => {
	test("the list filter's second service, accepted with Enter, becomes its where clause", () => {
		const focused = opened(Message.ClickedPanelType({ panel: "list" }), Message.FocusedQueryEditor())
		const listed = servicesAnswered(typed(focused, LIST_FILTER_ID, "service.name = ", listWhere), ["checkout", "payments"])
		const accepted = run(fresh(listed), ...accept(LIST_FILTER_ID))
		expect(accepted.model.state?.listWhereClause).toBe('service.name = "payments" ')
		expect(names(accepted)).toContain("PlaceWhereFieldCaret")
	})

	test("Apply on an engine list saves its query under a fresh id", () => {
		const listed = opened(Message.ClickedPanelType({ panel: "list" }))
		const asked = run(fresh(listed), Message.ClickedApply())
		expect(names(asked)).toEqual(["GenerateWidgetEditorId"])
		const saved = run(asked, Message.GeneratedId({ purpose: "applyList", source: "", id: "fresh-id" }))
		expect(JSON.stringify(saved.commands.at(-1)?.args)).toContain('"id":"fresh-id"')
		expect(saved.model.isSaving).toBe(true)
	})

	test("a caret in an attribute's value asks for its span values only once the provider is active", () => {
		const inactive = typed(opened(Message.ClickedPanelType({ panel: "list" })), LIST_FILTER_ID, "attr.http.route = ", listWhere)
		expect(names(inactive)).not.toContain("FetchWhereFieldValues")
		const active = typed(
			opened(Message.ClickedPanelType({ panel: "list" }), Message.FocusedQueryEditor()),
			LIST_FILTER_ID,
			"attr.http.route = ",
			listWhere,
		)
		expect(active.commands.filter(({ name }) => name === "FetchWhereFieldValues")).toHaveLength(1)
	})

	test("the funnel population offers the facets' countries and Enter accepts one", () => {
		const onPaths = opened(Message.ClickedPanelType({ panel: "paths" }))
		const typedIn = typed(countriesAnswered(onPaths, ["DE", "FR"]), populationFilterId("paths"), "country = ", population("paths"))
		const accepted = run(typedIn, ...accept(populationFilterId("paths")))
		expect(accepted.model.state?.paths.filterClause).toBe('country = "FR" ')
	})

	test("a funnel step's filter completes only `=`, and Enter writes it into the step", () => {
		const onFunnel = opened(Message.ClickedPanelType({ panel: "funnel" }), edit(ProductEdit.AddedStep()))
		const id = stepFilterId("funnel", 0)
		const typedIn = typed(onFunnel, id, "plan ", (value) =>
			ProductEdit.ChangedStepText({ scope: "funnel", index: 0, field: "filterClause", value }),
		)
		const accepted = run(typedIn, field(WhereFieldMessage.PressedEnter({ fieldId: id })))
		expect(accepted.model.state?.funnel.steps[0]).toMatchObject({ filterClause: "plan = " })
	})

	test("Enter after blur leaves the population text alone", () => {
		const id = populationFilterId("funnel")
		const typedIn = typed(opened(Message.ClickedPanelType({ panel: "funnel" })), id, "visitor_type = ", population("funnel"))
		const blurred = run(typedIn, field(WhereFieldMessage.GotCaret({ fieldId: id, message: CaretMessage.BlurredEditor() })))
		const pressed = run(fresh(blurred), field(WhereFieldMessage.PressedEnter({ fieldId: id })))
		expect(pressed.model.state?.funnel.filterClause).toBe("visitor_type = ")
		expect(pressed.commands).toEqual([])
	})
})
