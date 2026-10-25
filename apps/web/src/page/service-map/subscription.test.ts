import { OrgId } from "@maple/domain"
import { Effect, Option, Result, Schema, Stream } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { PageContext } from "../contract"
import { Message } from "./message"
import { MapBundle, type Model } from "./model"
import { subscriptions } from "./subscription"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const facetsWindow = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const STORED = { prefs: { minTrafficPct: 0, collapsedNamespaces: [] }, snapshots: [] }

const step = (model: Model, message: Message) => update(model, message, context).model

const withMap = (): Model => {
	const resolved = step(
		init({ search: {} }, context).model,
		Message.CompletedResolveWindow({ window, timeZone: "UTC", facetsWindow, nowMs: 0, mode: "Load" }),
	)
	const stored = step(resolved, Message.CompletedReadStored({ stored: STORED }))
	const bundle = {
		edges: [],
		dbEdges: [],
		dbEdgesTimedOut: false,
		overview: [],
		platforms: [],
		workloads: [],
	}
	return step(
		stored,
		Message.CompletedFetchBundle({
			key: stored.bundle.key ?? "",
			result: Result.succeed(new MapBundle(bundle)),
		}),
	)
}

const stubReducedMotion = (matches: boolean) =>
	vi.stubGlobal("window", {
		matchMedia: () => ({ matches, addEventListener: () => {}, removeEventListener: () => {} }),
	})

const { reducedMotion } = subscriptions

/** Feeds the subscription's first emit back through `update`, as the runtime does. */
const afterFirstEmit = (model: Model) =>
	Effect.runPromise(
		reducedMotion
			.dependenciesToStream(reducedMotion.modelToDependencies({ model, context }))
			.pipe(Stream.take(1), Stream.runCollect),
	).then((messages) => Array.from(messages).reduce(step, model))

const particlesGated = (model: Model) => Option.getOrThrow(model.map).reducedMotion

afterEach(() => vi.unstubAllGlobals())

describe("service map page: particle motion", () => {
	test("waits for the map, then opens the particle gate when motion is allowed", async () => {
		expect(
			reducedMotion.modelToDependencies({ model: init({ search: {} }, context).model, context }),
		).toEqual({
			hasMap: false,
		})
		const model = withMap()
		expect(particlesGated(model)).toBe(true)
		stubReducedMotion(false)
		expect(particlesGated(await afterFirstEmit(model))).toBe(false)
	})

	test("keeps the particles off under prefers-reduced-motion", async () => {
		stubReducedMotion(true)
		expect(particlesGated(await afterFirstEmit(withMap()))).toBe(true)
	})
})
