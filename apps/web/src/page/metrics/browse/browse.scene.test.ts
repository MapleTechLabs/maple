import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, label, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { PageOutMessage, type PageContext } from "../../contract"
import type { MetricRow } from "../shared"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-09-30 12:05:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const row = (metricName: string, metricType: string, serviceName = "checkout-api"): MetricRow => ({
	metricName,
	metricType,
	serviceName,
	metricDescription: "",
	metricUnit: "",
	dataPointCount: 10,
	firstSeen: "2026-09-30 12:05:00",
	lastSeen: "2026-10-01 12:00:00",
	isMonotonic: false,
})

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const windowed = (search: Parameters<typeof init>[0]["search"] = {}): Model =>
	pageUpdate(
		init({ search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model

const withCatalog = (model: Model, rows: ReadonlyArray<MetricRow>) =>
	pageUpdate(
		model,
		Message.CompletedFetchCatalog({ key: model.catalog.key ?? "", result: Result.succeed(rows) }),
	)

/** Catalog, chart runtime and theme are in: the grid can paint. */
const loaded = (rows: ReadonlyArray<MetricRow>): Model =>
	[Message.CompletedLoadChartRuntime(), Message.ResolvedThemeColors({ colors: {} })].reduce(
		(model, message) => pageUpdate(model, message).model,
		withCatalog(windowed(), rows).model,
	)

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const withPresence = (model: Model, status: "present" | "absent"): Model =>
	pageUpdate(
		model,
		Message.CompletedLoadSignalPresence({
			result: Result.succeed({ metrics: { status, lastSeenMs: null } }),
		}),
	).model

describe("metrics explorer", () => {
	test("entry resolves the window, then asks for the type counts and the catalog", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("ResolveMetricsWindow")
		const resolved = pageUpdate(
			init({ search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual(
			expect.arrayContaining(["FetchMetricsSummary", "FetchMetricsCatalog"]),
		)
	})

	test("the table view lists one row past its page, and never the grid catalog", () => {
		const model = windowed({ view: "table" })
		expect(model.catalog.key).toBeNull()
		expect(model.table.key).toContain('"limit":101')
	})

	test("a catalog answer for a superseded window is dropped", () => {
		const first = windowed()
		const second = pageUpdate(
			first,
			Message.CompletedResolveWindow({ window: later, nowMs: NOW, mode: "Load" }),
		).model
		const dropped = pageUpdate(
			second,
			Message.CompletedFetchCatalog({
				key: first.catalog.key ?? "",
				result: Result.succeed([row("stale", "gauge")]),
			}),
		)
		expect(dropped.model.catalog).toEqual(second.catalog)
	})

	test("the catalog asks one sparkline query per metric type, reused when the grid remounts", () => {
		const catalog = withCatalog(windowed(), [row("a", "gauge"), row("b", "gauge"), row("c", "sum")])
		expect(names(catalog.commands).filter((name) => name === "FetchMetricSparklines")).toHaveLength(2)
		const answered = Object.keys(catalog.model.sparklines).reduce(
			(model, key) =>
				pageUpdate(
					model,
					Message.CompletedFetchSparklines({ slot: key, key, result: Result.succeed([]) }),
				).model,
			catalog.model,
		)
		const narrowed = routeChanged(answered, { search: { type: "sum" } }, context)
		const remounted = withCatalog(narrowed.model, [row("c", "sum")])
		expect(names(remounted.commands)).toEqual([])
	})

	test("after a Reload a type change reads under the kept window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(windowed(), Message.ClickedReload()).model
		const typed = routeChanged(reloaded, { search: { type: "sum" } }, context)
		expect(names(typed.commands)).toEqual(["FetchMetricsCatalog"])
		expect(typed.model.window).toEqual(window)
		const moved = routeChanged(typed.model, { search: { type: "sum", timePreset: "1h" } }, context)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([["ResolveMetricsWindow", "Refresh"]])
	})

	test("a card shows its type and service, and opens the metric with its type", () => {
		const model = loaded([row("http.server.request.duration", "histogram")])
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("http.server.request.duration")).toExist(),
			expectView(text("Histogram")).toExist(),
			expectView(text("1 metric")).toExist(),
		)
		const opened = pageUpdate(
			model,
			Message.ClickedMetricCard({
				metricName: "http.server.request.duration",
				metricType: "histogram",
			}),
		)
		expect(opened.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/metrics/http.server.request.duration?type=histogram",
				isReplace: false,
			}),
		)
	})

	test("typing searches after the debounce, and only the last keystroke commits", () => {
		const model = loaded([row("a", "gauge")])
		const first = pageUpdate(model, Message.ChangedSearchInput({ value: "cp" })).model
		const second = pageUpdate(first, Message.ChangedSearchInput({ value: "cpu " })).model
		expect(
			pageUpdate(second, Message.CompletedSearchDebounce({ generation: first.searchGeneration }))
				.outMessage,
		).toBeUndefined()
		expect(
			pageUpdate(second, Message.CompletedSearchDebounce({ generation: second.searchGeneration }))
				.outMessage,
		).toEqual(PageOutMessage.RequestedNavigation({ url: "/metrics?q=cpu", isReplace: true }))
	})

	test("the view toggle writes `view=table`, and grid leaves the URL", () => {
		const model = loaded([row("a", "gauge")])
		expect(pageUpdate(model, Message.ClickedView({ view: "table" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/metrics?view=table", isReplace: true }),
		)
		expect(pageUpdate(model, Message.ClickedView({ view: "grid" })).outMessage).toBeUndefined()
	})

	test("an empty org shows a skeleton until presence is known, never the 'No metrics found' copy", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("LoadMetricsSignalPresence")
		scene(
			{ update: pageUpdate, view },
			given(loaded([])),
			themeResolved(),
			expectView(text("No metrics found")).not.toExist(),
			expectView(label("Loading")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withPresence(loaded([]), "absent")),
			themeResolved(),
			expectView(text("No metrics yet")).toExist(),
			expectView(role("link", { name: "Set up metrics" })).toHaveAttr(
				"href",
				"/settings?tab=ingestion",
			),
		)
	})
})
