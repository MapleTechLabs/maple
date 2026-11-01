import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { toLoadFailure } from "../../../data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import type { MetricRow } from "../shared"
import { MountWhereCaret } from "./command"
import { appendWhereFilter } from "./derive"
import { CaretMessage } from "./where-editor"
import { Message } from "./message"
import type { Model } from "./model"
import { draftOf, init, routeChanged, summaryOf, update, type Search } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-09-30 12:05:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const NAME = "http.server.request.duration"

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const row = (serviceName: string, metricType = "histogram", isMonotonic = false): MetricRow => ({
	metricName: NAME,
	metricType,
	serviceName,
	metricDescription: "Duration of HTTP server requests.",
	metricUnit: "s",
	dataPointCount: 2000,
	firstSeen: "2026-09-30 12:05:00",
	lastSeen: "2026-10-01 12:00:00",
	isMonotonic,
})

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const windowed = (search: Search = {}): Model =>
	pageUpdate(
		init({ metricName: NAME, search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model

const withCatalog = (model: Model, rows: ReadonlyArray<MetricRow>) =>
	pageUpdate(
		model,
		Message.CompletedFetchCatalog({ key: model.catalog.key ?? "", result: Result.succeed(rows) }),
	)

/** The catalog, the scoped keys and an empty chart and breakdown have loaded. */
const loaded = (rows: ReadonlyArray<MetricRow>, search: Search = {}): Model => {
	const base = withCatalog(windowed(search), rows).model
	const steps: ReadonlyArray<Message> = [
		Message.CompletedFetchAttributeKeys({
			key: base.attributeKeys.key ?? "",
			result: Result.succeed([{ attributeKey: "http.route", usageCount: 4100 }]),
		}),
		Message.CompletedFetchTimeseries({ key: base.timeseries.key ?? "", result: Result.succeed([]) }),
		Message.CompletedFetchBreakdown({
			key: base.breakdown.key ?? "",
			result: Result.succeed([{ name: "payment-svc", value: 0.171 }]),
		}),
		Message.CompletedLoadChartRuntime(),
		Message.ResolvedThemeColors({ colors: {} }),
	]
	return steps.reduce((model, message) => pageUpdate(model, message).model, base)
}

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

describe("metric detail", () => {
	test("entry asks for the catalog and every autocomplete lookup; the catalog unlocks the rest", () => {
		const resolved = pageUpdate(
			init({ metricName: NAME, search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual([
			"FetchMetricCatalog",
			...Array.from({ length: 7 }, () => "FetchMetricAutocomplete"),
		])
		const catalog = withCatalog(resolved.model, [row("checkout-api")])
		expect(names(catalog.commands)).toEqual(
			expect.arrayContaining([
				"FetchMetricAttributeKeys",
				"FetchMetricTimeseries",
				"FetchMetricBreakdown",
			]),
		)
	})

	test("counters default to rate and everything else to avg", () => {
		const sum = withCatalog(windowed(), [row("checkout-api", "sum", true)]).model
		const histogram = withCatalog(windowed(), [row("checkout-api")]).model
		const draftAggregation = (model: Model) => {
			const summary = summaryOf(model)
			return summary === null ? null : draftOf(model, summary).aggregation
		}
		expect(draftAggregation(sum)).toBe("rate")
		expect(draftAggregation(histogram)).toBe("avg")
	})

	test("a catalog answer for a superseded window is dropped", () => {
		const first = windowed()
		const second = pageUpdate(
			first,
			Message.CompletedResolveWindow({ window: later, nowMs: NOW, mode: "Load" }),
		).model
		const late = pageUpdate(
			second,
			Message.CompletedFetchCatalog({
				key: first.catalog.key ?? "",
				result: Result.succeed([row("stale")]),
			}),
		)
		expect(late.model.catalog).toEqual(second.catalog)
	})

	test("a breakdown bar narrows the where clause, replacing a filter on the same key", () => {
		const clicked = pageUpdate(
			loaded([row("payment-svc")]),
			Message.ClickedBreakdownValue({ groupBy: "service.name", value: "payment-svc" }),
		)
		expect(clicked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/metrics/${NAME}?where=service.name+%3D+%22payment-svc%22`,
				isReplace: true,
			}),
		)
		expect(appendWhereFilter('service.name = "a" AND x = "1"', "service.name", "b")).toBe(
			'service.name = "b" AND x = "1"',
		)
	})

	test("a where change in the URL re-asks the chart and breakdown, not the catalog", () => {
		const model = loaded([row("payment-svc")])
		const changed = routeChanged(
			model,
			{ metricName: NAME, search: { where: 'service.name = "payment-svc"' } },
			context,
		)
		expect(names(changed.commands)).toEqual(
			expect.arrayContaining(["FetchMetricTimeseries", "FetchMetricBreakdown"]),
		)
		expect(changed.model.whereInput).toBe('service.name = "payment-svc"')
	})

	test("Try again on a failed chart asks for the chart only, without a Reload", () => {
		const base = withCatalog(windowed(), [row("payment-svc")]).model
		const failed = [
			Message.CompletedFetchAttributeKeys({ key: base.attributeKeys.key ?? "", result: Result.succeed([]) }),
			Message.CompletedFetchTimeseries({ key: base.timeseries.key ?? "", result: Result.fail(toLoadFailure("down")) }),
			Message.CompletedFetchBreakdown({ key: base.breakdown.key ?? "", result: Result.succeed([]) }),
		].reduce((model, message) => pageUpdate(model, message).model, base)
		const retried = pageUpdate(failed, Message.ClickedRetryChart())
		expect(names(retried.commands)).toEqual(["FetchMetricTimeseries"])
		expect(retried.model.isReloading).toBe(false)
	})

	test("after a Reload a where change reads under the kept window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(loaded([row("payment-svc")]), Message.ClickedReload()).model
		const search = { where: 'service.name = "payment-svc"' }
		const filtered = routeChanged(reloaded, { metricName: NAME, search }, context)
		expect(names(filtered.commands)).not.toContain("ResolveMetricWindow")
		expect(names(filtered.commands)).toContain("FetchMetricTimeseries")
		const moved = routeChanged(
			filtered.model,
			{ metricName: NAME, search: { ...search, timePreset: "1h" } },
			context,
		)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([
			["ResolveMetricWindow", "Refresh"],
		])
	})

	test("the where clause commits after the debounce, and the step only when it changed", () => {
		const model = loaded([row("payment-svc")])
		const typed = pageUpdate(model, Message.ChangedWhereInput({ value: 'http.route = "/a"' })).model
		expect(
			pageUpdate(typed, Message.CompletedWhereDebounce({ generation: typed.whereGeneration }))
				.outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/metrics/${NAME}?where=http.route+%3D+%22%2Fa%22`,
				isReplace: true,
			}),
		)
		expect(pageUpdate(model, Message.CommittedStepInput()).outMessage).toBeUndefined()
		const stepped = pageUpdate(model, Message.ChangedStepInput({ value: "300" })).model
		expect(pageUpdate(stepped, Message.CommittedStepInput()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: `/metrics/${NAME}?step=%22300%22`, isReplace: true }),
		)
	})

	test("the page shows the query, the breakdown and the catalog summary", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([row("payment-svc"), row("checkout-api")])),
			themeResolved(),
			Mount.resolve(MountWhereCaret, Message.GotCaretMessage({ message: CaretMessage.BlurredEditor() })),
			expectView(text(`avg(${NAME})`)).toExist(),
			expectView(text("Top values · avg per value")).toExist(),
			expectView(role("button", { name: /^Filter to service\.name = payment-svc/ })).toExist(),
			expectView(text("No datapoints match this query in the selected range.")).toExist(),
			expectView(text("http.route")).toExist(),
			expectView(role("button", { name: "Copy Link" })).toExist(),
		)
	})

	test("a metric with no catalog rows in the window says so", () => {
		scene(
			{ update: pageUpdate, view },
			given(withCatalog(windowed(), []).model),
			themeResolved(),
			expectView(text("No data for this metric in the selected range")).toExist(),
		)
	})
})
