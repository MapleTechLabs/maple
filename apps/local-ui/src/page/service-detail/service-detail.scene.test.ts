import { ResolveThemeColors, ThemeMessage } from "@maple/web/charts/theme-colors"
import { Option } from "effect"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { FetchGoldenSignals, FetchOperations, FetchOverview, FetchTimeseries } from "./command"
import { Message } from "./message"
import type { Model, OperationRow } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const NOW = Date.parse("2026-10-01T12:00:30Z")
const context: PageContext = {
	env: { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false },
	location: { path: "/services/checkout-api", search: "" },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
}
const inputs: PageViewInputs = {
	context,
	presenceOf: () => Option.none(),
	presenceNowMs: NOW,
	clockMs: 0,
	hasNewDataSince: () => false,
}
const view = withViewInputs(pageView, inputs)()
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const operation = (spanName: string): OperationRow => ({
	spanName,
	spanCount: 30,
	estimatedSpanCount: 0,
	errorCount: 0,
	estimatedErrorCount: 0,
	errorRate: 0,
	avgDurationMs: 5,
	p50DurationMs: 4,
	p95DurationMs: 6,
	p99DurationMs: 7,
})

const anchored = () =>
	pageUpdate(init(context, "checkout-api").model, Message.CompletedReadClock({ nowMs: NOW }))

describe("local service detail", () => {
	test("entry asks the overview, operations and golden signals; the operations chart waits for operations", () => {
		expect(names(anchored().commands)).toEqual([
			FetchOverview.name,
			FetchOperations.name,
			FetchGoldenSignals.name,
		])
		const base = anchored().model
		const withOps = pageUpdate(
			base,
			Message.SucceededFetchOperations({
				key: base.operations.key ?? "",
				operations: [operation("POST /checkout")],
				fetchedAtMs: 0,
			}),
		)
		expect(names(withOps.commands)).toEqual([FetchTimeseries.name])
	})

	test("an answer for a superseded key is dropped", () => {
		const base = anchored().model
		const stale = pageUpdate(
			base,
			Message.SucceededFetchOperations({ key: "stale", operations: [operation("x")], fetchedAtMs: 0 }),
		)
		expect(stale.model.operations).toEqual(base.operations)
	})

	test("a quiet service offers to widen the range", () => {
		const base = anchored().model
		const quiet = pageUpdate(
			base,
			Message.SucceededFetchOverview({
				key: base.overview.key ?? "",
				overview: null,
				fetchedAtMs: NOW,
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(quiet.model),
			themeResolved(),
			expectView(text("No spans from this service in this range")).toExist(),
			click(role("button", { name: "Widen to 30 days" })),
			expectOutMessage(
				PageOutMessage.RememberedRange({ range: "30d", hash: "#/services/checkout-api?range=30d" }),
			),
		)
	})
})
