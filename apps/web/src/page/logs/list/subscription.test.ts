import { OrgId } from "@maple/domain"
import { Effect, Fiber, Ref, Result, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { PageContext } from "../../contract"
import * as LogDetail from "../detail"
import { Message } from "./message"
import type { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const log = (body: string) => ({
	timestamp: "2026-10-01T11:59:00.000Z",
	exactTimestamp: "2026-10-01 11:59:00.000000000",
	severityText: "INFO",
	severityNumber: 9,
	serviceName: "checkout",
	body,
	traceId: undefined,
	spanId: undefined,
	logAttributes: {},
	resourceAttributes: {},
})

const step = (model: Model, message: Message) => update(model, message, context).model

const withRows = (model: Model, body: string, mode: "Load" | "Refresh"): Model => {
	const resolved = step(model, Message.CompletedResolveWindow({ window, nowMs: NOW + 1, mode }))
	return step(
		resolved,
		Message.CompletedFetchFirstPage({
			key: resolved.firstPage.key ?? "",
			result: Result.succeed({ logs: [log(body)], cursor: null }),
		}),
	)
}

const interval = (model: Model) =>
	subscriptions.autoRefresh.modelToDependencies({ model, context }).intervalSeconds

afterEach(() => vi.unstubAllGlobals())

describe("logs live tail", () => {
	test("stays paused while the detail sheet is open, even after new rows arrive", () => {
		const loaded = withRows(init({ search: { refresh: 5 } }, context).model, "first", "Load")
		expect(interval(loaded)).toBe(5)
		const opened = { ...loaded, detail: LogDetail.open(loaded.detail, log("first"), context).model, selectedIndex: 0 }
		const refreshed = withRows({ ...opened, refreshVersion: 1 }, "second", "Refresh")
		expect(refreshed.selectedIndex).toBeNull()
		expect(interval(refreshed)).toBe(0)
	})

	test("skips ticks while the tab is hidden", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const hidden = Object.assign(new EventTarget(), { hidden: true })
				vi.stubGlobal("document", hidden)
				const ticks = yield* Ref.make(0)
				const fiber = yield* Effect.forkChild(
					Stream.runForEach(subscriptions.autoRefresh.dependenciesToStream({ intervalSeconds: 5 }), () =>
						Ref.update(ticks, (n) => n + 1),
					),
				)
				yield* TestClock.adjust("30 seconds")
				expect(yield* Ref.get(ticks)).toBe(0)
				hidden.hidden = false
				yield* TestClock.adjust("5 seconds")
				expect(yield* Ref.get(ticks)).toBe(1)
				yield* Fiber.interrupt(fiber)
			}).pipe(Effect.provide(TestClock.layer())),
		))
})
