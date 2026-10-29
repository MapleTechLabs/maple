import { Option, Result } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { toLoadFailure } from "../../../data/load-failure"
import { FetchCorrelationSeries } from "./command"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { view as panelView, type ViewInputs } from "./view"
import { anchoredWindow, MountInfraCorrelation } from "./window"

const POD = {
	"k8s.pod.name": "payment-svc-7f9c-p0",
	"k8s.namespace.name": "shop",
	"k8s.node.name": "ip-10-0-12-84",
}
const window = { startTime: "2026-10-01 11:45:00", endTime: "2026-10-01 12:15:00" }
const inputs = (resourceAttributes: ViewInputs["resourceAttributes"]): ViewInputs => ({
	resourceAttributes,
	anchor: "2026-10-01 12:00:00",
	spanDurationMs: 0,
	timeZone: "UTC",
})

const resolved = (model: Model = init("panel", "org_acme")) =>
	update(model, Message.ResolvedWindow({ window, resourceAttributes: POD }))

const mounted = () => [
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
	Mount.resolve(MountInfraCorrelation, Message.CompletedMountLinkedCursor()),
]

describe("infra correlation panel", () => {
	test("a log's window is 15 minutes either side, and a span's covers its duration", () => {
		expect(anchoredWindow("2026-10-01 12:00:00", 0)).toEqual(Option.some(window))
		expect(anchoredWindow("2026-10-01 12:00:00", 90_500)).toEqual(
			Option.some({ startTime: window.startTime, endTime: "2026-10-01 12:16:30" }),
		)
		expect(anchoredWindow("not a time", 0)).toEqual(Option.none())
	})

	test("a pod record reads the pod's and its node's three charts, then loads the chart library", () => {
		const names = (resolved().commands ?? []).map(({ name }) => name)
		expect(names.filter((name) => name === FetchCorrelationSeries.name)).toHaveLength(6)
		expect(names.at(-1)).toBe(LoadChartRuntime.name)
		expect(Object.keys(resolved().model.series)).toEqual([
			"pod-cpu_usage",
			"pod-cpu_limit",
			"pod-memory_limit",
			"node-cpu_usage",
			"node-cpu_utilization",
			"node-memory_utilization",
		])
		expect(Object.keys(resolved().model.charts)).toEqual(Object.keys(resolved().model.series))
	})

	test("an answer for another key is dropped", () => {
		const model = resolved().model
		const late = update(
			model,
			Message.CompletedFetchSeries({
				chartId: "pod-cpu_usage",
				key: "stale",
				result: Result.succeed({ rows: [], unit: "cores" }),
			}),
		)
		expect(late.model.series["pod-cpu_usage"]).toEqual(model.series["pod-cpu_usage"])
	})

	test("each group links to its infra page; a failed read shows its message", () => {
		const model = resolved().model
		const failed = update(
			model,
			Message.CompletedFetchSeries({
				chartId: "node-cpu_usage",
				key: model.series["node-cpu_usage"]?.key ?? "",
				result: Result.fail({ ...toLoadFailure("boom"), message: "node series down" }),
			}),
		).model
		scene(
			{ update, view: withViewInputs(panelView, inputs(POD))() },
			given(failed),
			...mounted(),
			expectView(text("Pod")).toExist(),
			expectView(text("node series down")).toExist(),
		)
	})

	test("a record with no infra identity explains which attributes link it", () => {
		scene(
			{ update, view: withViewInputs(panelView, inputs({ "service.name": "checkout" }))() },
			given(init("panel", "org_acme")),
			expectView(text("No Kubernetes, container, or host metadata on this record.")).toExist(),
		)
	})
})
