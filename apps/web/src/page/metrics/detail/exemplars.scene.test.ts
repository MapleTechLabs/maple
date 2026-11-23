import { OrgId } from "@maple/domain"
import type { MetricDistributionRow, MetricExemplarRow } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"

import { describe, expect, test } from "vitest"
import * as Chart from "@maple/views/charts/chart"
import { MeasureChartContainer, MountChart } from "@maple/views/charts/chart-mounts"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { PageOutMessage, type PageContext } from "../../contract"
import type { MetricRow } from "../shared"
import { MountWhereCaret } from "./command"
import { distributionCells, timeGrid, valueFormat } from "./exemplars"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update, type Search } from "./update"
import { CaretMessage } from "./where-editor"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.UTC(2026, 9, 1, 12)
const NAME = "http.server.request.duration"

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const row = (metricType: string): MetricRow => ({
	metricName: NAME,
	metricType,
	serviceName: "checkout-api",
	metricDescription: "",
	metricUnit: "s",
	dataPointCount: 2000,
	firstSeen: "2026-09-30 12:05:00",
	lastSeen: "2026-10-01 12:00:00",
	isMonotonic: false,
})

const MINUTE_A = "2026-10-01T11:00:00.000Z"
const MINUTE_B = "2026-10-01T11:01:00.000Z"

const exemplar = (bucket: string, value: number, traceId: string): MetricExemplarRow => ({
	bucket,
	timestamp: bucket,
	value,
	traceId,
	spanId: `${traceId}-span`,
	serviceName: "checkout-api",
})

const EXEMPLARS: ReadonlyArray<MetricExemplarRow> = [
	exemplar(MINUTE_A, 2.5, "trace-slow"),
	exemplar(MINUTE_A, 0.04, "trace-fast"),
	exemplar(MINUTE_B, 0.3, "trace-mid"),
]

const cell = (bucket: string, lowerBound: number | null, upperBound: number | null, count: number) => ({
	bucket,
	lowerBound,
	upperBound,
	count,
})

const DISTRIBUTION: ReadonlyArray<MetricDistributionRow> = [
	cell(MINUTE_A, null, 0.1, 40),
	cell(MINUTE_A, 1, null, 3),
	cell(MINUTE_B, 0.1, 1, 12),
]

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const step = (model: Model, message: Message) => pageUpdate(model, message).model

const windowed = (search: Search) =>
	step(
		init({ metricName: NAME, search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	)

const withCatalog = (model: Model, metricType: string) =>
	pageUpdate(
		model,
		Message.CompletedFetchCatalog({
			key: model.catalog.key ?? "",
			result: Result.succeed([row(metricType)]),
		}),
	)

/** The page with its chart, exemplars and (when asked for) the distribution loaded. */
const loaded = (metricType: string, search: Search = {}): Model => {
	const base = withCatalog(windowed(search), metricType).model
	const steps: ReadonlyArray<Message> = [
		Message.CompletedFetchTimeseries({ key: base.timeseries.key ?? "", result: Result.succeed([]) }),
		Message.CompletedFetchExemplars({ key: base.exemplars.key ?? "", result: Result.succeed(EXEMPLARS) }),
		Message.CompletedFetchDistribution({
			key: base.distribution.key ?? "",
			result: Result.succeed({ rows: DISTRIBUTION, bucketSeconds: 60 }),
		}),
		Message.CompletedLoadChartRuntime(),
		Message.ResolvedThemeColors({ colors: {} }),
	]
	return Arr.reduce(steps, base, step)
}

const settled = () => [
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
	Mount.resolve(MountWhereCaret, Message.GotCaretMessage({ message: CaretMessage.BlurredEditor() })),
]

const pick = (key: string | null) =>
	Message.GotDistributionChartMessage({
		message: Chart.Message.SelectedChartPoint({ maybeKey: Option.fromNullishOr(key) }),
	})

describe("metric exemplars and distribution", () => {
	test("every metric asks for its exemplars; only a histogram showing its distribution asks for buckets", () => {
		const fetched = (metricType: string, search: Search) =>
			names(withCatalog(windowed(search), metricType).commands)
		expect(fetched("gauge", {})).toContain("FetchMetricExemplars")
		expect(fetched("histogram", {})).not.toContain("FetchMetricDistribution")
		expect(fetched("histogram", { display: "distribution" })).toContain("FetchMetricDistribution")
		expect(fetched("gauge", { display: "distribution" })).not.toContain("FetchMetricDistribution")
	})

	test("the exemplars panel lists each trace behind the values, highest first as served", () =>
		scene(
			{ update: pageUpdate, view },
			given(loaded("histogram")),
			...settled(),
			expectView(text("Exemplars")).toExist(),
			expectView(role("link", { name: "Open the trace behind 2.50s" })).toExist(),
			expectView(role("cell", { name: "trace-mid" })).toExist(),
		))

	test("a histogram offers its distribution; a gauge has no buckets to show", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded("histogram")),
			...settled(),
			expectView(role("button", { name: "Distribution" })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded("gauge")),
			...settled(),
			expectView(role("button", { name: "Distribution" })).not.toExist(),
		)
		expect(
			pageUpdate(loaded("histogram"), Message.ChangedChartDisplay({ display: "distribution" }))
				.outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/metrics/${NAME}?display=distribution`,
				isReplace: true,
			}),
		)
	})

	test("picking a heatmap cell reads that cell's exemplars and lists them; picking it again shows all", () => {
		const shown = loaded("histogram", { display: "distribution" })
		const slowCell = `${MINUTE_A}\u00001|inf`
		const picked = pageUpdate(shown, pick(slowCell))
		expect(names(picked.commands)).toEqual(["FetchMetricCellExemplars"])
		const answered = step(
			picked.model,
			Message.CompletedFetchCellExemplars({
				key: picked.model.cellExemplars.key ?? "",
				result: Result.succeed([exemplar(MINUTE_A, 2.5, "trace-slow")]),
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(answered),
			...settled(),
			Mount.resolve(MountChart, Chart.Message.CompletedMountChart()),
			Mount.resolve(
				MeasureChartContainer,
				Chart.Message.ResizedChartContainer({ width: 800, height: 300 }),
			),
			expectView(text("In the picked cell")).toExist(),
			expectView(role("cell", { name: "trace-slow" })).toExist(),
			expectView(role("cell", { name: "trace-mid" })).not.toExist(),
		)
		expect(step(answered, pick(slowCell)).selectedCell).toBeNull()
		expect(step(answered, Message.ClearedCellSelection()).selectedCell).toBeNull()
	})

	test("a pick of a cell the new buckets no longer have is dropped", () => {
		const shown = loaded("histogram", { display: "distribution" })
		const picked = step(shown, pick(`${MINUTE_A}\u00001|inf`))
		const moved = step(
			picked,
			Message.CompletedFetchDistribution({
				key: picked.distribution.key ?? "",
				result: Result.succeed({ rows: [cell(MINUTE_B, 0.1, 1, 12)], bucketSeconds: 60 }),
			}),
		)
		expect(moved.selectedCell).toBeNull()
	})

	test("a new where clause drops the pick and its traces; a reload of the same scope keeps them", () => {
		const shown = loaded("histogram", { display: "distribution" })
		const picked = step(shown, pick(`${MINUTE_A}\u00001|inf`))
		const answered = step(
			picked,
			Message.CompletedFetchCellExemplars({
				key: picked.cellExemplars.key ?? "",
				result: Result.succeed([exemplar(MINUTE_A, 2.5, "trace-slow")]),
			}),
		)
		const narrowed = routeChanged(
			answered,
			{ metricName: NAME, search: { display: "distribution", where: 'http.route = "/a"' } },
			context,
		).model
		expect(narrowed.selectedCell).toBeNull()
		expect(narrowed.cellExemplars.key).toBeNull()
		const reloaded = routeChanged(
			answered,
			{ metricName: NAME, search: { display: "distribution" } },
			context,
		).model
		expect(reloaded.selectedCell).toBe(answered.selectedCell)
	})

	test("an exemplar dot opens its trace at its span", () => {
		expect(
			pageUpdate(loaded("gauge"), Message.ClickedExemplar({ traceId: "trace-slow", spanId: "s1" }))
				.outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/traces/trace-slow?spanId=s1", isReplace: false }),
		)
	})

	test("heatmap rows are keyed by their exact edges, lowest first, and labelled for reading", () => {
		const { cells, labels } = distributionCells(DISTRIBUTION, valueFormat("duration_s"))
		const keys = Arr.dedupe(Arr.map(cells, (c) => c.y))
		expect(keys).toEqual(["-inf|0.1", "0.1|1", "1|inf"])
		expect(Arr.map(keys, (key) => labels[key])).toEqual(["≤ 100ms", "≤ 1.00s", "> 1.00s"])
	})

	test("two layouts sharing an upper edge, or edges that format alike, stay separate rows", () => {
		const { cells, labels } = distributionCells(
			[
				cell(MINUTE_A, 0.01, 0.02, 3),
				cell(MINUTE_A, 0.015, 0.02, 1),
				cell(MINUTE_A, 1.001, 1.002, 2),
				cell(MINUTE_A, 1.002, 1.003, 5),
			],
			valueFormat("duration_s"),
		)
		expect(cells.length).toBe(4)
		expect(labels["0.01|0.02"]).toBe("10.0ms – 20.0ms")
		expect(labels["0.015|0.02"]).toBe("15.0ms – 20.0ms")
	})

	test("the heatmap gets every minute of the window, so a quiet stretch keeps its width", () => {
		const grid = timeGrid({ startTime: "2026-10-01 11:00:30", endTime: "2026-10-01 11:05:00" }, 60)
		expect(grid).toEqual([
			"2026-10-01T11:00:00.000Z",
			"2026-10-01T11:01:00.000Z",
			"2026-10-01T11:02:00.000Z",
			"2026-10-01T11:03:00.000Z",
			"2026-10-01T11:04:00.000Z",
			"2026-10-01T11:05:00.000Z",
		])
	})
})
