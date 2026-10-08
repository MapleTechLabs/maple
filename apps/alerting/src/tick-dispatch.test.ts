import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { authorizeTickRequest, dispatchTick, SELF_BINDING, TICK_PATH } from "./tick-dispatch"

const CRONS = ["* * * * *", "0 * * * *"]
const TOKEN = "secret-token"

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

describe("authorizeTickRequest", () => {
	it("accepts a known cron with the internal bearer", () => {
		const tick = authorizeTickRequest(
			tickRequest({ cron: "0 * * * *", authorization: `Bearer ${TOKEN}` }),
			Option.some(TOKEN),
			CRONS,
		)
		expect(tick).toEqual({ cron: "0 * * * *", colo: "unknown", placement: "none" })
	})

	it("refuses a wrong token, a missing token config, and an unknown cron", () => {
		const authorized = `Bearer ${TOKEN}`
		expect(
			authorizeTickRequest(
				tickRequest({ cron: "* * * * *", authorization: "Bearer nope" }),
				Option.some(TOKEN),
				CRONS,
			),
		).toBe(401)
		expect(
			authorizeTickRequest(
				tickRequest({ cron: "* * * * *", authorization: authorized }),
				Option.none(),
				CRONS,
			),
		).toBe(401)
		expect(
			authorizeTickRequest(
				tickRequest({ cron: "*/7 * * * *", authorization: authorized }),
				Option.some(TOKEN),
				CRONS,
			),
		).toBe(400)
		expect(authorizeTickRequest(tickRequest({ method: "GET" }), Option.some(TOKEN), CRONS)).toBe(404)
		expect(authorizeTickRequest(tickRequest({ path: "/" }), Option.some(TOKEN), CRONS)).toBe(404)
	})
})

describe("dispatchTick", () => {
	it.effect("posts the cron to the self binding with the internal bearer", () =>
		Effect.gen(function* () {
			const { binding, seen } = fakeBinding(204)
			const result = yield* dispatchTick("*/5 * * * *", {
				[SELF_BINDING]: binding,
				INTERNAL_SERVICE_TOKEN: TOKEN,
			})
			expect(result).toBe("placed")
			expect(seen).toHaveLength(1)
			const request = seen[0]!
			const tick = authorizeTickRequest(request, Option.some(TOKEN), ["*/5 * * * *"])
			expect(tick).toMatchObject({ cron: "*/5 * * * *" })
		}),
	)

	it.effect("is unavailable without a binding or a token, or when the handler refuses", () =>
		Effect.gen(function* () {
			expect(yield* dispatchTick("* * * * *", { INTERNAL_SERVICE_TOKEN: TOKEN })).toBe("unavailable")
			const { binding, seen } = fakeBinding(204)
			expect(yield* dispatchTick("* * * * *", { [SELF_BINDING]: binding })).toBe("unavailable")
			expect(seen).toHaveLength(0)
			const refused = fakeBinding(401)
			expect(
				yield* dispatchTick("* * * * *", {
					[SELF_BINDING]: refused.binding,
					INTERNAL_SERVICE_TOKEN: TOKEN,
				}),
			).toBe("unavailable")
		}),
	)

	it.effect("does not follow a redirect, so the bearer stays on the hop", () =>
		Effect.gen(function* () {
			const { binding, seen } = fakeBinding(302)
			const error = yield* dispatchTick("* * * * *", {
				[SELF_BINDING]: binding,
				INTERNAL_SERVICE_TOKEN: TOKEN,
			}).pipe(Effect.flip)
			expect(seen[0]?.redirect).toBe("manual")
			expect(error.status).toBe(302)
		}),
	)

	it.effect("fails on a handler error, so the caller does not rerun a partial tick", () =>
		Effect.gen(function* () {
			const { binding } = fakeBinding(500)
			const error = yield* dispatchTick("* * * * *", {
				[SELF_BINDING]: binding,
				INTERNAL_SERVICE_TOKEN: TOKEN,
			}).pipe(Effect.flip)
			expect(error._tag).toBe("@maple/alerting/errors/TickDispatchError")
			expect(error.status).toBe(500)
		}),
	)
})
