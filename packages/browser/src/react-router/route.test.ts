import type { InstrumentationHandlerResult, InstrumentRouteFunction } from "react-router"
import { describe, expect, it, vi } from "vitest"
import { matchedPattern, routePattern, traceRouteHandlers } from "./route"

describe("routePattern", () => {
	it("adds the leading slash framework mode's patterns leave off", () => {
		expect(routePattern("projects/:id")).toBe("/projects/:id")
		expect(routePattern("/projects/:id")).toBe("/projects/:id")
		expect(routePattern("")).toBe("/")
	})
})

describe("matchedPattern", () => {
	it("joins the paths of the matched routes, skipping layout and index routes", () => {
		expect(matchedPattern(["/", undefined, "projects/:id", undefined])).toBe("/projects/:id")
		expect(matchedPattern(["", "docs", "*"])).toBe("/docs/*")
		expect(matchedPattern([undefined])).toBe("/")
		expect(matchedPattern([])).toBe("/")
	})
})

/** What a route instrumentation registers: `{ loader, action, ... }`. */
type RouteInstrumentations = Parameters<Parameters<InstrumentRouteFunction>[0]["instrument"]>[0]

describe("traceRouteHandlers", () => {
	/** The instrumentations `traceRouteHandlers` registers for a route. */
	const instrument = (traced: (name: string, fn: () => Promise<void>) => Promise<void>) => {
		let registered: RouteInstrumentations = {}
		traceRouteHandlers(traced)({
			id: "routes/project",
			index: undefined,
			path: "projects/:id",
			instrument: (instrumentations) => {
				registered = instrumentations
			},
		})
		return registered
	}
	const info = {} as Parameters<NonNullable<RouteInstrumentations["loader"]>>[1]

	it("names loader and action spans after the route id", async () => {
		const traced = vi.fn(async (_name: string, fn: () => Promise<void>) => fn())
		const handlers = instrument(traced)
		const handler = vi.fn(async (): Promise<InstrumentationHandlerResult> => ({
			status: "success",
			error: undefined,
		}))
		await handlers.loader?.(handler, info)
		await handlers.action?.(handler, info)

		expect(traced.mock.calls.map(([name]) => name)).toEqual([
			"loader routes/project",
			"action routes/project",
		])
		expect(handler).toHaveBeenCalledTimes(2)
	})

	it("hands a failed handler's error to traced and never throws itself", async () => {
		const error = new Error("loader exploded")
		let seen: unknown
		const handlers = instrument(async (_name, fn) => {
			try {
				await fn()
			} catch (thrown) {
				seen = thrown
				throw thrown
			}
		})
		await expect(
			handlers.loader?.(async () => ({ status: "error", error }), info),
		).resolves.toBeUndefined()

		expect(seen).toBe(error)
	})
})
