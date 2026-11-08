import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, placeholder, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import * as Combobox from "@maple/views/ui/combobox"
import * as Dialog from "@maple/views/ui/dialog"
import { CaretMessage } from "../../kit/where-autocomplete"
import { WhereFieldMessage } from "../../kit/where-field"
import { MountWhereFieldCaret } from "../../kit/where-field-command"
import type { PageContext } from "../../contract"
import * as QueryPanel from "../../kit/query-builder/panel"
import { NOW, ORG } from "../shared/test-rows"
import { init } from "./init"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./update"
import { view as pageView } from "./view"

// The alert query builder's metrics source: the picker's list, the group-by keys, the
// picked metric's display, and the traces-only `root_only` filter on a source switch.

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const view = withViewInputs(pageView, { context })()
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const DRAFT_ID = "6f1c2e3a-0000-4000-8000-000000000001"
/** The page's mounts: the theme, the closed templates dialog and the where editor's caret. */
const mounted = () => [
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
	Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
	// Resolved with the query panel's message: the page's submodel wraps it.
	Mount.resolve<string, QueryPanel.Message>(
		MountWhereFieldCaret,
		QueryPanel.Message.GotWhereField({
			message: WhereFieldMessage.GotCaret({ fieldId: DRAFT_ID, message: CaretMessage.BlurredEditor() }),
		}),
	),
]
const comboMounted = () => Mount.resolve(Combobox.MountCombobox, Combobox.Message.CompletedMountCombobox())

type Step = Readonly<{ model: Model; names: ReadonlyArray<string> }>
const step = (model: Model, message: Message): Step => {
	const next = update(model, message, context)
	return { model: next.model, names: Arr.map(next.commands ?? [], ({ name }) => name) }
}
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => step(current, message).model)

const panel = (message: QueryPanel.Message) => Message.GotQueryPanelMessage({ message })
const pickSelect = (field: string, value: string) =>
	panel(
		QueryPanel.Message.GotSelectMessage({
			id: `${field}:${DRAFT_ID}`,
			message: { _tag: "SelectedItem", index: 0, value },
		}),
	)
const metricPicker = (message: Combobox.Message) =>
	panel(QueryPanel.Message.GotMetricMessage({ queryId: DRAFT_ID, value: "", message }))

/** A blank new rule in the query builder, on its default traces draft. */
const blank = () =>
	run(init({ _tag: "AlertsCreate", search: {} }, context).model, [
		Message.GeneratedDraftId({ id: DRAFT_ID }),
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.ClickedStartBlank(),
	])

const PAGE = {
	options: [
		{ value: "shop.orders.created::sum", label: "shop.orders.created (sum)", isMonotonic: true },
		{
			value: "process.cpu.utilization::gauge",
			label: "process.cpu.utilization (gauge)",
			isMonotonic: false,
		},
	],
	services: ["checkout"],
}

const onMetrics = () => {
	const switched = step(blank(), pickSelect("source", "metrics"))
	return {
		...switched,
		model: run(switched.model, [
			Message.CompletedFetchMetricOptions({ search: "", result: Result.succeed(PAGE) }),
		]),
	}
}

const picked = () => {
	const chosen = step(
		onMetrics().model,
		metricPicker({ _tag: "ClickedItem", value: "shop.orders.created::sum" }),
	)
	return {
		...chosen,
		model: run(chosen.model, [
			Message.CompletedFetchMetricKeys({
				metric: "shop.orders.created::sum",
				result: Result.succeed({ attributes: ["http.route"], resources: ["host.name"] }),
			}),
		]),
	}
}

describe("alert editor metrics query", () => {
	test("switching to Metrics lists the org's metrics, and typing searches them", () => {
		const switched = step(blank(), pickSelect("source", "metrics"))
		expect(switched.names).toContain("FetchAlertEditorMetricOptions")
		const searched = step(onMetrics().model, metricPicker({ _tag: "ChangedInput", value: "cpu" }))
		expect(searched.names).toContain("FetchAlertEditorMetricOptions")
		expect(searched.model.metricSearch).toBe("cpu")
		const opened = run(onMetrics().model, [metricPicker({ _tag: "ClickedInput" })])
		scene(
			{ update: pageUpdate, view },
			given(opened),
			...mounted(),
			comboMounted(),
			expectView(text("shop.orders.created (sum)")).toExist(),
			expectView(text("process.cpu.utilization (gauge)")).toExist(),
		)
	})

	test("a failed metric list is asked for again on the next edit", () => {
		const failed = run(step(blank(), pickSelect("source", "metrics")).model, [
			Message.CompletedFetchMetricOptions({ search: "", result: Result.fail(toLoadFailure("down")) }),
		])
		const edited = step(failed, Message.ChangedField({ field: "name", value: "Orders" }))
		expect(edited.names).toContain("FetchAlertEditorMetricOptions")
	})

	test("root spans only is a traces filter: switching to Metrics drops it and keeps the rest", () => {
		const rooted = run(blank(), [
			panel(
				QueryPanel.Message.ChangedText({
					queryId: DRAFT_ID,
					field: "whereClause",
					value: 'service.name = "api"',
				}),
			),
			pickSelect("spans", "root"),
		])
		expect(rooted.form?.queryBuilderDraft.whereClause).toBe('service.name = "api" AND root_only = true')
		const switched = run(rooted, [pickSelect("source", "metrics")])
		expect(switched.form?.queryBuilderDraft.whereClause).toBe('service.name = "api"')
	})

	test("a picked metric sets the draft and reads its keys, which the group-by picker offers", () => {
		const chosen = picked()
		expect(chosen.names).toContain("FetchAlertEditorMetricKeys")
		const draft = chosen.model.form?.queryBuilderDraft
		expect(draft?.dataSource === "metrics" ? [draft.metricName, draft.metricType] : null).toEqual([
			"shop.orders.created",
			"sum",
		])
		const opened = run(chosen.model, [
			panel(
				QueryPanel.Message.GotGroupByMessage({
					queryId: DRAFT_ID,
					message: { _tag: "ClickedInput" },
				}),
			),
		])
		scene(
			{ update: pageUpdate, view },
			given(opened),
			...mounted(),
			comboMounted(),
			expectView(text("attr.http.route")).toExist(),
			expectView(text("resource.host.name")).toExist(),
		)
	})

	test("the picked metric reads as its name, with its type beside it, never name::type", () => {
		scene(
			{ update: pageUpdate, view },
			given(picked().model),
			...mounted(),
			expectView(placeholder("Search metrics…")).toHaveValue("shop.orders.created"),
			expectView(text("sum")).toExist(),
		)
	})
})
