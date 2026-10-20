import { OrgId } from "@maple/domain"
import { createFormulaDraft, createQueryDraft } from "@maple/query-engine/query-builder"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { requestKey } from "../../data/request-key"
import * as Select from "../../ui/select"
import type { QueryDraft } from "../../page/kit/query-builder/draft"
import * as TimeRangePicker from "../../page/kit/time-range-picker"
import { type Flags, Message, type Model } from "./model"
import { init, NO_ENABLED_QUERIES, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const NOON = Date.UTC(2026, 9, 1, 12, 0, 0)
const HOUR = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }

const draft = (index: number): QueryDraft => ({ ...createQueryDraft(index), id: `q${index}` })

const flags = (search: Flags["search"] = {}): Flags => ({
	nowMs: NOON,
	timeZone: "UTC",
	search,
	queries: [draft(0), draft(1)],
	formulas: [{ ...createFormulaDraft(0, ["A", "B"]), id: "f0" }],
})

type Step = Readonly<{
	model: Model
	commands?: ReadonlyArray<{ readonly name: string; readonly args?: unknown }>
}>

const names = (step: Step) => (step.commands ?? []).map((command) => command.name)
const argsOf = (step: Step, name: string) =>
	(step.commands ?? []).filter((command) => command.name === name).map((command) => command.args)

const signedIn = (search?: Flags["search"]): Model =>
	update(init(flags(search)).model, Message.SucceededCheckSession({ orgId })).model

describe("query builder lab", () => {
	test("entry resolves the default hour from the flags' clock and checks the session first", () => {
		const entry = init(flags())
		expect(entry.model.window).toEqual(HOUR)
		expect(names(entry)).toEqual(["CheckQueryBuilderLabSession"])
	})

	test("an absolute window from the URL is used as is", () => {
		const window = { startTime: "2026-09-30 08:00:00", endTime: "2026-09-30 09:00:00" }
		expect(init(flags(window)).model.window).toEqual(window)
	})

	test("the session sends every autocomplete lookup over the window and the metric list", () => {
		const step = update(init(flags()).model, Message.SucceededCheckSession({ orgId }))
		expect(argsOf(step, "FetchQueryBuilderLabAutocomplete")).toHaveLength(7)
		expect(argsOf(step, "FetchQueryBuilderLabAutocomplete")).toContainEqual({
			key: requestKey(orgId, "autocomplete.spanAttributeKeys", HOUR),
			lookup: "spanAttributeKeys",
			window: HOUR,
		})
		expect(argsOf(step, "FetchQueryBuilderLabMetrics")).toEqual([
			{ key: requestKey(orgId, "listMetrics", { data: { limit: 300 } }) },
		])
	})

	test("a lookup answer for a superseded window is dropped", () => {
		const later = { startTime: "2026-10-01 11:30:00", endTime: "2026-10-01 12:30:00" }
		const moved = update(
			signedIn(),
			Message.CompletedResolveWindow({ window: later, mode: "Refresh" }),
		).model
		const stale = update(
			moved,
			Message.CompletedFetchAutocomplete({
				key: requestKey(orgId, "autocomplete.spanAttributeKeys", HOUR),
				lookup: "spanAttributeKeys",
				result: Result.succeed({ keys: ["http.route"] }),
			}),
		).model
		expect(stale.autocomplete["spanAttributeKeys"]?.data._tag).toBe("Loading")
	})

	test("running with no enabled query shows the error and submits nothing", () => {
		const disabled = update(
			update(signedIn(), Message.ToggledEnabled({ queryId: "q0" })).model,
			Message.ToggledEnabled({ queryId: "q1" }),
		)
		const run = update(disabled.model, Message.ClickedRun())
		expect(run.model.noQueriesError).toBe(NO_ENABLED_QUERIES)
		expect(run.model.submitted).toBeNull()
		expect(names(run)).toEqual([])
	})

	test("running submits the window, every draft and the formulas, and stamps the run", () => {
		const model = signedIn()
		const run = update(model, Message.ClickedRun())
		const input = { ...HOUR, queries: model.queries, formulas: model.formulas }
		expect(run.model.submitted).toEqual(input)
		expect(argsOf(run, "FetchQueryBuilderLabTimeseries")).toEqual([
			{ key: requestKey(orgId, "getQueryBuilderTimeseries", { data: input }), input },
		])
		expect(names(run)).toContain("StampQueryBuilderLabRun")
		expect(update(run.model, Message.StampedRun({ at: "12:00:00 PM" })).model.lastRunAt).toBe(
			"12:00:00 PM",
		)
	})

	test("reload re-resolves unsnapped, refreshes the metrics and the submitted run, and spins once", () => {
		const metricsKey = requestKey(orgId, "listMetrics", { data: { limit: 300 } })
		const loaded = update(
			signedIn(),
			Message.CompletedFetchMetrics({ key: metricsKey, result: Result.succeed([]) }),
		)
		const run = update(loaded.model, Message.ClickedRun())
		const [runArgs] = argsOf(run, "FetchQueryBuilderLabTimeseries")
		const runKey = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(runArgs).key
		const answer = Result.succeed({ points: [], warnings: [] })
		const ran = update(run.model, Message.CompletedFetchTimeseries({ key: runKey, result: answer })).model
		const reload = update(ran, Message.ClickedReload())
		expect(argsOf(reload, "ResolveQueryBuilderLabWindow")).toEqual([
			{ search: {}, preset: "1h", timeZone: "UTC", mode: "Refresh" },
		])
		expect(names(reload)).toContain("FetchQueryBuilderLabMetrics")
		expect(names(reload)).toContain("FetchQueryBuilderLabTimeseries")
		const again = update(reload.model, Message.ClickedReload()).model
		expect(update(again, Message.CompletedReloadSpin({ version: 1 })).model.isReloading).toBe(true)
		expect(update(again, Message.CompletedReloadSpin({ version: 2 })).model.isReloading).toBe(false)
	})

	test("a picked preset replaces the window search and resolves it snapped", () => {
		const step = update(
			signedIn({ startTime: "2026-09-30 08:00:00", endTime: "2026-09-30 09:00:00" }),
			Message.GotPickerMessage({ message: TimeRangePicker.Message.ClickedPreset({ value: "6h" }) }),
		)
		expect(step.model.search).toEqual({ timePreset: "6h" })
		expect(argsOf(step, "ResolveQueryBuilderLabWindow")).toEqual([
			{ search: { timePreset: "6h" }, preset: "6h", timeZone: "UTC", mode: "Load" },
		])
	})

	test("clone appends a copy under a new id and relabels; remove relabels and keeps the last query", () => {
		const cloned = update(signedIn(), Message.CreatedCloneId({ queryId: "q0", id: "q9" })).model
		expect(cloned.queries.map((query) => [query.id, query.name])).toEqual([
			["q0", "A"],
			["q1", "B"],
			["q9", "C"],
		])
		const removed = update(cloned, Message.ClickedRemoveQuery({ queryId: "q0" })).model
		expect(removed.queries.map((query) => [query.id, query.name])).toEqual([
			["q1", "A"],
			["q9", "B"],
		])
		const single = { ...removed, queries: removed.queries.slice(0, 1) }
		expect(update(single, Message.ClickedRemoveQuery({ queryId: "q1" })).model.queries).toHaveLength(1)
	})

	test("switching a query to metrics resets it, and the metric list fills its metric", () => {
		const switched = update(
			signedIn(),
			Message.GotSelectMessage({
				id: "source:q1",
				message: Select.Message.SelectedItem({ index: 2, value: "metrics" }),
			}),
		).model
		const query = switched.queries[1]
		expect(query?.dataSource).toBe("metrics")
		const filled = update(
			switched,
			Message.CompletedFetchMetrics({
				key: requestKey(orgId, "listMetrics", { data: { limit: 300 } }),
				result: Result.succeed([
					{ metricName: "bogus", metricType: "summary" },
					{ metricName: "http.server.duration", metricType: "histogram" },
				]),
			}),
		).model.queries[1]
		expect(filled?.dataSource === "metrics" ? [filled.metricName, filled.metricType] : null).toEqual([
			"http.server.duration",
			"histogram",
		])
	})
})
