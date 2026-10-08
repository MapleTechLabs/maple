import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { authorizeTickRequest, dispatchTick, SELF_BINDING, TICK_PATH } from "./tick-dispatch"

const CRONS = ["* * * * *", "0 * * * *"]
const TOKEN = "secret-token"
const ENV = { INTERNAL_SERVICE_TOKEN: TOKEN }

const tickRequest = (init: { cron?: string; authorization?: string; method?: string; path?: string }) => {
	const url = new URL(`https://maple-alerting.internal${init.path ?? TICK_PATH}`)
	if (init.cron !== undefined) url.searchParams.set("cron", init.cron)
	return new Request(url, {
		method: init.method ?? "POST",
		headers: init.authorization === undefined ? {} : { authorization: init.authorization },
	})
}

/** A service binding that answers with `status` and records what it was sent. */
const fakeBinding = (status: number) => {
	const seen: Array<Request> = []
	const binding = {
		fetch: (input: RequestInfo, init?: RequestInit) => {
			seen.push(new Request(input, init))
			return Promise.resolve(new Response(null, { status }))
		},
	}
	return { binding, seen }
}

/** The refusal status for `request`, failing the test if it was authorized. */
const refusedStatus = (request: Request, env: Record<string, unknown>) =>
	authorizeTickRequest(request, env, CRONS).pipe(
		Effect.flip,
		Effect.map((error) => {
			expect(error._tag).toBe("@maple/alerting/errors/TickRequestRefused")
			return error.status
		}),
	)

describe("authorizeTickRequest", () => {
	it.effect("accepts a known cron with the internal bearer", () =>
		Effect.gen(function* () {
			const tick = yield* authorizeTickRequest(
				tickRequest({ cron: "0 * * * *", authorization: `Bearer ${TOKEN}` }),
				ENV,
				CRONS,
			)
			expect(tick).toEqual({ cron: "0 * * * *", colo: "unknown", placement: "none" })
		}),
	)

	it.effect("refuses a wrong token, a missing token config, and an unknown cron", () =>
		Effect.gen(function* () {
			const authorized = `Bearer ${TOKEN}`
			expect(
				yield* refusedStatus(tickRequest({ cron: "* * * * *", authorization: "Bearer nope" }), ENV),
			).toBe(401)
			expect(
				yield* refusedStatus(tickRequest({ cron: "* * * * *", authorization: authorized }), {}),
			).toBe(401)
			expect(
				yield* refusedStatus(tickRequest({ cron: "*/7 * * * *", authorization: authorized }), ENV),
			).toBe(400)
			expect(yield* refusedStatus(tickRequest({ method: "GET" }), ENV)).toBe(404)
			expect(yield* refusedStatus(tickRequest({ path: "/" }), ENV)).toBe(404)
		}),
	)
})

/** The real failure of a dispatch; an unavailable dispatch fails the test. */
const dispatchFailure = (env: Record<string, unknown>) =>
	dispatchTick("* * * * *", env).pipe(
		Effect.catchTag("@maple/alerting/errors/TickDispatchUnavailable", Effect.die),
		Effect.flip,
	)

describe("dispatchTick", () => {
	it.effect("posts the cron to the self binding with the internal bearer", () =>
		Effect.gen(function* () {
			const { binding, seen } = fakeBinding(204)
			yield* dispatchTick("*/5 * * * *", { ...ENV, [SELF_BINDING]: binding })
			expect(seen).toHaveLength(1)
			const tick = yield* authorizeTickRequest(seen[0]!, ENV, ["*/5 * * * *"])
			expect(tick).toMatchObject({ cron: "*/5 * * * *" })
		}),
	)

	it.effect("is unavailable without a binding or a token, or when the handler refuses", () =>
		Effect.gen(function* () {
			const unavailableReason = (env: Record<string, unknown>) =>
				dispatchTick("* * * * *", env).pipe(
					Effect.catchTag("@maple/alerting/errors/TickDispatchError", Effect.die),
					Effect.flip,
					Effect.map((error) => error.reason),
				)
			expect(yield* unavailableReason(ENV)).toBe("no-binding")
			const { binding, seen } = fakeBinding(204)
			expect(yield* unavailableReason({ [SELF_BINDING]: binding })).toBe("no-token")
			expect(seen).toHaveLength(0)
			expect(yield* unavailableReason({ ...ENV, [SELF_BINDING]: fakeBinding(401).binding })).toBe(
				"refused-401",
			)
			expect(yield* unavailableReason({ ...ENV, [SELF_BINDING]: fakeBinding(404).binding })).toBe(
				"refused-404",
			)
		}),
	)

	it.effect("does not follow a redirect, so the bearer stays on the hop", () =>
		Effect.gen(function* () {
			const { binding, seen } = fakeBinding(302)
			const error = yield* dispatchFailure({ ...ENV, [SELF_BINDING]: binding })
			expect(seen[0]?.redirect).toBe("manual")
			expect(error.status).toBe(302)
		}),
	)

	it.effect("fails on a handler error, so the caller does not rerun a partial tick", () =>
		Effect.gen(function* () {
			const error = yield* dispatchFailure({ ...ENV, [SELF_BINDING]: fakeBinding(500).binding })
			expect(error._tag).toBe("@maple/alerting/errors/TickDispatchError")
			expect(error.status).toBe(500)
		}),
	)
})
