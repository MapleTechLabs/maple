import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import * as ProfileFlamegraph from "@maple/views/profiles/profile-flamegraph"
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
import { init, locationChanged, update } from "./update"
import { view as pageView } from "./view"
import { Array as Arr } from "effect"

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
	presenceOf: () => ({ status: "unknown", lastSeenMs: null }),
	presenceNowMs: NOW,
	clockMs: 0,
	hasNewDataSince: () => false,
}
const view = withViewInputs(pageView, inputs)()
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
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
	test("another range opens the profile whole; a refresh of the same window keeps the view", () => {
		const searched = pageUpdate(
			anchored().model,
			Message.GotFlamegraphMessage({
				message: ProfileFlamegraph.Message.ChangedSearch({ value: "parse" }),
			}),
		).model
		expect(searched.profile.key).not.toBeNull()

		// The refresh reads the clock, then reloads the same window.
		const refreshing = pageUpdate(searched, Message.ClickedRefresh()).model
		const refreshed = pageUpdate(refreshing, Message.CompletedReadRefreshClock({ nowMs: NOW })).model
		expect(refreshed.profile.key).not.toBeNull()
		expect(refreshed.flamegraph.search).toBe("parse")
		expect(refreshed.flamegraph.resetToken).toBe(0)

		const widened = locationChanged(searched, {
			...context,
			location: { path: "/services/checkout-api", search: "range=6h" },
		}).model
		expect(widened.profile.key).not.toBe(searched.profile.key)
		expect(widened.flamegraph.search).toBe("")
		expect(widened.flamegraph.resetToken).toBe(1)
	})

	test("entry asks the overview, operations and golden signals; the operations chart waits for operations", () => {
		expect(names(anchored().commands)).toEqual(
			expect.arrayContaining([FetchOverview.name, FetchOperations.name, FetchGoldenSignals.name]),
		)
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
			expectView(text("No spans from this service in this window")).toExist(),
			click(role("button", { name: "Widen to 30 days" })),
			expectOutMessage(
				PageOutMessage.RememberedRange({ range: "30d", hash: "#/services/checkout-api?range=30d" }),
			),
		)
	})
	test("a window with profile samples and no spans still shows the profile", () => {
		const base = anchored().model
		const quiet = pageUpdate(
			base,
			Message.SucceededFetchOverview({
				key: base.overview.key ?? "",
				overview: null,
				fetchedAtMs: NOW,
			}),
		).model
		const profiled = pageUpdate(
			quiet,
			Message.SucceededFetchProfile({
				key: quiet.profile.key ?? "",
				profile: {
					sampleType: "cpu",
					sampleUnit: "nanoseconds",
					totalValue: 9_000_000,
					totalStacks: 1,
					durationNano: 60_000_000_000,
					stacks: [{ frames: ["main"], files: ["/app/main.js"], lines: [1], value: 9_000_000 }],
				},
				fetchedAtMs: NOW,
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(profiled),
			themeResolved(),
			Mount.resolve(
				ProfileFlamegraph.MountFlameChart({ chartId: profiled.flamegraph.id, maxRows: 22 }),
				Message.GotFlamegraphMessage({
					message: ProfileFlamegraph.Message.ChangedZoom({ isZoomed: false }),
				}),
			),
			expectView(text("No spans from this service in this window")).toExist(),
			expectView(role("table", { name: "Top functions" })).toExist(),
		)
	})
})
