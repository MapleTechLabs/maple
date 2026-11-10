import { OrgId } from "@maple/domain"
import { Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { CaretMessage } from "../../kit/where-autocomplete"
import { WhereFieldMessage } from "../../kit/where-field"
import { autocompleteOf } from "../../kit/where-field-update"
import { specOf } from "./advanced"
import { ADVANCED_FIELD_ID } from "./advanced-model"
import { chipId, listInput, logFilterChips, type Search, volumeInput } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const anchor = { left: 0, top: 0, bottom: 40, width: 300, viewportHeight: 800 }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const windowed = (search: Search = {}): Model =>
	pageUpdate(
		init({ search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
	).model

const caret = (message: CaretMessage) =>
	Message.GotWhereFieldMessage({
		message: WhereFieldMessage.GotCaret({ fieldId: ADVANCED_FIELD_ID, message }),
	})

/** The search a navigation out-message carries, read back through the route. */
const searchOf = (result: { readonly outMessage?: unknown }): Search => {
	const out = result.outMessage
	if (typeof out !== "object" || out === null || !("url" in out)) throw new Error("no navigation")
	const params = new URL(String(out.url), "https://app.test").searchParams
	return Rec.fromEntries(
		Arr.map([...params.entries()], ([key, value]): [string, unknown] => [
			key,
			Str.startsWith("[")(value) ? JSON.parse(value) : value,
		]),
	)
}

describe("logs advanced filter", () => {
	test("F or the button opens the dialog on the URL's clause and asks for resource keys once", () => {
		const opened = pageUpdate(
			windowed({ whereClause: 'severity = "ERROR"' }),
			Message.ClickedAdvancedFilter(),
		)
		expect(opened.model.advanced.dialog.isOpen).toBe(true)
		expect(opened.model.advanced.draft).toBe('severity = "ERROR"')
		expect(names(opened.commands)).toContain("FetchLogsResourceKeys")
	})

	test("focusing the editor suggests the logs keys, picking one inserts it", () => {
		const opened = pageUpdate(windowed(), Message.ClickedAdvancedFilter()).model
		const focused = pageUpdate(opened, caret(CaretMessage.FocusedEditor({ cursor: 0, anchor }))).model
		const labels = Arr.map(
			autocompleteOf(focused.advanced.fields, ADVANCED_FIELD_ID, specOf(focused)).suggestions,
			(s) => s.label,
		)
		expect(labels).toEqual(
			expect.arrayContaining(["service.name", "severity", "deployment.environment", "body"]),
		)
		const picked = pageUpdate(
			focused,
			Message.GotWhereFieldMessage({
				message: WhereFieldMessage.AppliedSuggestion({ fieldId: ADVANCED_FIELD_ID, index: 0 }),
			}),
		).model
		expect(picked.advanced.draft).toMatch(/^service\.name/)
	})

	test("applying writes the clause and its params, and the list request carries every operator", () => {
		const opened = pageUpdate(windowed(), Message.ClickedAdvancedFilter()).model
		const typed = pageUpdate(
			opened,
			Message.ChangedAdvancedDraft({
				value: 'severity = "ERROR" AND attr.http.route contains "/api" AND resource.k8s.pod.name exists',
			}),
		).model
		const applied = pageUpdate(typed, Message.SubmittedAdvanced())
		expect(applied.model.advanced.dialog.isOpen).toBe(false)
		const search = searchOf(applied)
		expect(search.severities).toEqual(["ERROR"])
		expect(search.whereClause).toContain("attr.http.route")

		const routed = routeChanged(applied.model, { search }, context)
		expect(names(routed.commands)).toContain("FetchLogsFirstPage")
		const input = listInput(routed.model.search, window, null)
		expect(input.severities).toEqual(["ERROR"])
		expect(input.attributeFilters).toEqual([{ key: "http.route", value: "/api", mode: "contains" }])
		expect(input.resourceAttributeFilters).toEqual([{ key: "k8s.pod.name", mode: "exists" }])
	})

	test("Enter with no suggestion open applies the filter", () => {
		const opened = pageUpdate(windowed(), Message.ClickedAdvancedFilter()).model
		const typed = pageUpdate(
			opened,
			Message.ChangedAdvancedDraft({ value: 'body contains "timeout"' }),
		).model
		const entered = pageUpdate(
			typed,
			Message.GotWhereFieldMessage({
				message: WhereFieldMessage.PressedEnter({ fieldId: ADVANCED_FIELD_ID }),
			}),
		)
		expect(searchOf(entered).search).toBe("timeout")
		expect(entered.model.searchText).toBe("timeout")
	})

	test("an attribute chip removes only its own predicate; the panel's clear drops the clause", () => {
		const model = windowed({
			whereClause: 'attr.a = "1" AND attr.b != "2"',
			attributeFilters: [
				{ key: "a", value: "1" },
				{ key: "b", value: "2", negated: true },
			],
		})
		const chip = Arr.findFirst(logFilterChips(model.search), (c) => c.label === "b")
		if (chip._tag === "None") throw new Error("no chip")
		expect(chip.value.negated).toBe(true)
		const removed = searchOf(pageUpdate(model, Message.RemovedFilterChip({ chipId: chipId(chip.value) })))
		expect(removed.attributeFilters).toEqual([{ key: "a", value: "1" }])
		// The clause no longer describes the list, so its panel goes with the chip.
		expect(removed.whereClause).toBeUndefined()

		const cleared = searchOf(pageUpdate(model, Message.ClickedClearWhereClause()))
		expect(cleared.whereClause).toBeUndefined()
		expect(cleared.attributeFilters).toBeUndefined()
	})

	test("the volume chart matches environment and namespace the way the list does", () => {
		const search = { deploymentEnvs: ["prod"], deploymentEnvMatchMode: "contains" as const }
		expect(volumeInput(search, window, 300, null).filters).toMatchObject({
			environments: ["prod"],
			deploymentEnvMatchMode: "contains",
		})
	})

	test("removing the environment chip or picking one in the sidebar drops the substring mode", () => {
		const model = windowed({ deploymentEnvs: ["prod"], deploymentEnvMatchMode: "contains" })
		const chip = Arr.findFirst(logFilterChips(model.search), (c) => c.param === "deploymentEnvs")
		if (chip._tag === "None") throw new Error("no chip")
		expect(chip.value.operator).toBe("contains")
		const removed = searchOf(pageUpdate(model, Message.RemovedFilterChip({ chipId: chipId(chip.value) })))
		expect(removed.deploymentEnvMatchMode).toBeUndefined()
		const picked = searchOf(
			pageUpdate(model, Message.ToggledFacetOption({ facet: "deploymentEnvs", name: "staging" })),
		)
		expect(picked.deploymentEnvs).toEqual(["prod", "staging"])
		expect(picked.deploymentEnvMatchMode).toBeUndefined()
	})
})
