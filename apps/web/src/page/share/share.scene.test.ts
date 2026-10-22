import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors } from "../../charts/theme-colors"
import type { PageContext } from "../contract"
import { FetchBatch, ResolveReloadClock, ResolveShare } from "./command"
import { Message } from "./message"
import type { Model, SharedDashboard, ShareWidget } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("public"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.parse("2026-10-01T12:00:00Z")
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const answer = (batchId: number) => Message.CompletedFetchBatch({ batchId, keys: {}, states: {} })

const widget = (id: string): ShareWidget => ({
	id,
	visualization: "stat",
	display: { title: id },
	layout: { x: 0, y: 0, w: 3, h: 4 },
	dataSource: { kind: "route" },
})

const share = (count: number): SharedDashboard => ({
	mode: "public",
	scope: "dashboard",
	embeddable: false,
	dashboard: {
		id: "dash_1",
		name: "Platform overview",
		timeRange: { type: "relative", value: "6h" },
		widgets: Array.from({ length: count }, (_, i) => widget(`w${i}`)),
		sections: [],
	},
})

const resolved = (count: number): Model =>
	[
		Message.CompletedResolveClock({ nowMs: NOW }),
		Message.CompletedResolveShare({ token: "tok", resolve: { _tag: "Ready", share: share(count) } }),
	].reduce((model, message) => update(model, message).model, init({ token: "tok", search: {} }).model)

const measured = (count: number): Model =>
	Array.from({ length: count }, (_, i) => i).reduce(
		(model, i) => update(model, Message.MeasuredWidget({ widgetId: `w${i}`, maxDataPoints: 300 })).model,
		resolved(count),
	)

describe("share", () => {
	test("entry resolves the token and the clock", () => {
		expect(names(init({ token: "tok", search: {} }).commands)).toContain(ResolveShare.name)
		expect(resolved(1).window?.label).toBe("Last 6 hours")
	})

	test("tiles reported in one frame are fetched in batches of four, one batch at a time", () => {
		const flushed = update(measured(6), Message.CompletedFlushFrame())
		expect(names(flushed.commands)).toEqual([FetchBatch.name])
		expect(flushed.model.queuedBatches).toHaveLength(1)
		const answered = update(flushed.model, answer(flushed.model.sentBatchId))
		expect(names(answered.commands)).toEqual([FetchBatch.name])
		expect(answered.model.queuedBatches).toHaveLength(0)
	})

	test("a reload drops batches queued for the old window", () => {
		const flushed = update(measured(6), Message.CompletedFlushFrame())
		const reloaded = update(
			flushed.model,
			Message.CompletedResolveReloadClock({ nowMs: NOW + 5 * 60_000 }),
		).model
		const queuedKeys = reloaded.queuedBatches.flatMap((batch) =>
			batch.requests.map((request) => request.key),
		)
		expect(queuedKeys.every((key) => key.includes("12:05:00"))).toBe(true)
	})

	test("the old window's answer after a reload does not send the new window's queued batch early", () => {
		const flushed = update(measured(6), Message.CompletedFlushFrame()).model
		const reloaded = update(flushed, Message.CompletedResolveReloadClock({ nowMs: NOW + 5 * 60_000 }))
		expect(names(reloaded.commands)).toEqual([FetchBatch.name])
		const stale = update(reloaded.model, answer(flushed.sentBatchId))
		expect(names(stale.commands)).toEqual([])
		expect(stale.model.queuedBatches).toHaveLength(1)
		const current = update(stale.model, answer(reloaded.model.sentBatchId))
		expect(names(current.commands)).toEqual([FetchBatch.name])
		expect(names(update(current.model, answer(current.model.sentBatchId)).commands)).toEqual([])
	})

	test("a tile the answer left out settles as a failure, not loading", () => {
		const flushed = update(measured(1), Message.CompletedFlushFrame()).model
		const answered = update(
			flushed,
			Message.CompletedFetchBatch({
				batchId: flushed.sentBatchId,
				keys: { w0: flushed.requested.w0 ?? "" },
				states: {},
			}),
		)
		expect(answered.model.states.w0?._tag).toBe("Error")
	})

	test("a reload refetches every reported tile", () => {
		const settled = update(measured(2), Message.CompletedFlushFrame()).model
		expect(names(update(settled, Message.CompletedFlushFrame()).commands)).toEqual([])
		const clicked = update(settled, Message.ClickedReload())
		expect(names(clicked.commands)).toEqual([ResolveReloadClock.name])
		expect(
			names(update(clicked.model, Message.CompletedResolveReloadClock({ nowMs: NOW })).commands),
		).toContain(FetchBatch.name)
	})

	test("a reload or an auto-refresh tick moves a relative window to the current time", () => {
		const settled = update(measured(1), Message.CompletedFlushFrame()).model
		const later = NOW + 5 * 60_000
		const ticked = update(settled, Message.TickedAutoRefresh())
		expect(names(ticked.commands)).toEqual([ResolveReloadClock.name])
		const moved = update(ticked.model, Message.CompletedResolveReloadClock({ nowMs: later })).model
		expect(moved.window?.endTime).not.toBe(settled.window?.endTime)
		expect(moved.window?.endTime).toBe("2026-10-01 12:05:00")
	})

	test("an unknown link renders the unavailable card", () => {
		scene(
			{ update: (model, message) => update(model, message), view },
			given(
				update(
					init({ token: "tok", search: {} }).model,
					Message.CompletedResolveShare({
						token: "tok",
						resolve: { _tag: "Failed", error: { _tag: "NotFound" } },
					}),
				).model,
			),
			Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} })),
			expectView(text("This link isn't available")).toExist(),
		)
	})

	test("a resolved board shows its window and name", () => {
		scene(
			{ update: (model, message) => update(model, message), view },
			given(resolved(0)),
			Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} })),
			expectView(text("Platform overview")).toExist(),
			expectView(text("This dashboard has no charts yet")).toExist(),
		)
	})
})
