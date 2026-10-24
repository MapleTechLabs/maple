import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	attr,
	expect as expectView,
	find,
	given,
	Mount,
	scene,
	selector,
	Subscription,
	tap,
} from "foldkit/scene"
import { Lazy } from "foldkit/test"
import { describe, expect, test } from "vitest"
import * as Chart from "../../charts/chart"
import { MountChart, PortalTooltipBody } from "../../charts/chart-mounts"
import { CHART_SPEC_ATTRIBUTE, decodeChartSpec } from "../../charts/chart-spec"
import { LinkedCursorMessage, MountLinkedCursor } from "../../charts/linked-cursor"
import type { PageContext } from "../contract"
import * as TimeRangePicker from "../kit/time-range-picker"
import { Message } from "./message"
import type { Model, OverviewPoint } from "./model"
import { init, update } from "./update"
import { metricsGrid } from "./view-metrics"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const point: OverviewPoint = {
	bucket: "2026-10-01 11:00:00",
	throughput: 100,
	tracedThroughput: 100,
	hasSampling: false,
	samplingWeight: 1,
	errorRate: 0.01,
	p50LatencyMs: 20,
	p95LatencyMs: 80,
	p99LatencyMs: 120,
	apdexScore: 0.95,
	totalCount: 100,
	partial: false,
}
const IDS = ["throughput", "error-rate", "latency", "log-volume"]
const ready = (): Model => {
	const base = init({ search: {} }, context).model
	return {
		...base,
		charts: Object.fromEntries(IDS.map((id) => [id, Chart.init()])),
		overviewSeries: { ...base.overviewSeries, key: "overview", data: AsyncData.succeed([point]) },
		logSeries: { ...base.logSeries, data: AsyncData.succeed([{ bucket: point.bucket, count: 50 }]) },
		refinement: { ...base.refinement, data: AsyncData.succeed([]) },
		presence: AsyncData.succeed({
			traces: { status: "present", lastSeenMs: null },
			logs: { status: "present", lastSeenMs: null },
		}),
	}
}
const EMPTY_COLORS = {}
const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	metricsGrid(h, model, {
		colors: model.themeColors ?? EMPTY_COLORS,
		isChartReady: true,
		timeZone: "UTC",
		nowMs: 0,
		useRefinement: false,
	})
// Exercise the view's invalidation independently of the request Commands covered by overview.scene.
const pageUpdate = (model: Model, message: Message) => ({ model: update(model, message, context).model })
const mounted = () =>
	Mount.resolveAll(
		[MountLinkedCursor, LinkedCursorMessage.CompletedMountLinkedCursor()],
		[MountChart, Chart.Message.CompletedMountChart()],
		[MountChart, Chart.Message.CompletedMountChart()],
		[MountChart, Chart.Message.CompletedMountChart()],
		[MountChart, Chart.Message.CompletedMountChart()],
	)
const card = (html: NonNullable<Html>, id: string) =>
	Option.getOrThrow(find(html, `[data-linked-cursor-chart="${id}"]`))

describe("overview metric card caches", () => {
	test("unchanged cards reuse their views", () => {
		Lazy.expectAllReused({ view, model: ready() })
	})

	test("a tooltip opens and hides after cached renders", () => {
		scene(
			{ update: pageUpdate, view },
			given(ready()),
			mounted(),
			Subscription.emit(
				Message.GotChartMessage({
					chartId: "throughput",
					message: Chart.Message.ChangedChartTooltip({
						maybeTooltip: Option.some({
							_tag: "Bucket",
							heading: "11:00",
							rows: [{ label: "Requests", value: "100", color: "green", dashed: false }],
						}),
					}),
				}),
			),
			Mount.resolve(PortalTooltipBody, Chart.Message.CompletedPortalTooltipBody()),
			expectView(selector("[data-chart-tooltip-holder]")).toContainText("11:00"),
			Subscription.emit(
				Message.GotChartMessage({
					chartId: "throughput",
					message: Chart.Message.ChangedChartTooltip({ maybeTooltip: Option.none() }),
				}),
			),
			Mount.expectEnded(PortalTooltipBody),
			expectView(selector("[data-chart-tooltip-holder]")).toBeEmpty(),
		)
	})

	test("a new series replaces the cached chart spec and summary", () => {
		scene(
			{ update: pageUpdate, view },
			given(ready()),
			mounted(),
			Subscription.emit(
				Message.CompletedFetchOverviewSeries({
					key: "overview",
					result: Result.succeed([{ ...point, throughput: 250 }]),
				}),
			),
			expectView(selector('[data-linked-cursor-chart="throughput"]')).toContainText("250"),
			tap(({ html }) => {
				const spec = Option.getOrThrow(
					Option.flatMap(
						Option.flatMap(
							find(card(html, "throughput"), "[data-chart-spec]"),
							attr(CHART_SPEC_ATTRIBUTE),
						),
						decodeChartSpec,
					),
				)
				expect(spec._tag === "FixedMetric" ? spec.rows[0]?.throughput : undefined).toBe(250)
			}),
		)
	})

	test("theme and parent timezone changes reach the chart specs", () => {
		let timeZone = "UTC"
		const themedView = (model: Model, h: HtmlBuilder<Message>) =>
			metricsGrid(h, model, {
				colors: model.themeColors ?? EMPTY_COLORS,
				isChartReady: true,
				timeZone,
				nowMs: 0,
				useRefinement: false,
			})
		const expectSpec = (colors: string, zone: string) =>
			tap<Model, Message>(({ html }) => {
				const spec = Option.getOrThrow(
					Option.flatMap(
						Option.flatMap(
							find(card(html, "throughput"), "[data-chart-spec]"),
							attr(CHART_SPEC_ATTRIBUTE),
						),
						decodeChartSpec,
					),
				)
				expect(
					spec._tag === "FixedMetric"
						? { color: spec.colors.throughput, zone: spec.timeZone }
						: undefined,
				).toEqual({ color: colors, zone })
			})
		scene(
			{ update: pageUpdate, view: themedView },
			given(ready()),
			mounted(),
			Subscription.emit(Message.ResolvedThemeColors({ colors: { "--chart-throughput": "#22c55e" } })),
			expectSpec("#22c55e", "UTC"),
			tap(() => {
				timeZone = "America/New_York"
			}),
			Subscription.emit(
				Message.GotTimePickerMessage({
					message: TimeRangePicker.Message.ChangedShorthand({ value: "2h" }),
				}),
			),
			expectSpec("#22c55e", "America/New_York"),
		)
	})
})
