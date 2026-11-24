import { afterAll, describe, expect, it } from "@effect/vitest"
import { AlertMemberDirectoryUnavailableError, AlertPersistenceError } from "@maple/domain/http"
import { Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/http"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { ShareRateLimiter } from "@maple/backend/services/auth/ShareRateLimiter"
import { onCallCalendarFeedUrl, OnCallCalendarRouter } from "./oncall-calendar.http"

const TOKEN = "mcal_known"
const CALENDAR = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"
const asked: Array<string> = []

/** One feed exists, behind `TOKEN`; `mcal_down` and `mcal_nodir` stand for two things being down. */
const schedules = Layer.mock(OnCallSchedulesService)({
	calendarFeed: (token) => {
		asked.push(token)
		if (token === "mcal_down")
			return Effect.fail(new AlertPersistenceError({ message: "Alert persistence failed" }))
		if (token === "mcal_nodir")
			return Effect.fail(
				new AlertMemberDirectoryUnavailableError({ message: "No answer", cause: "timeout" }),
			)
		return Effect.succeed(token === TOKEN ? Option.some(CALENDAR) : Option.none())
	},
})

const limited = { now: false }
const checked: Array<{ readonly tokenHashPrefix: string; readonly ip: string | undefined }> = []
const rateLimiter = Layer.succeed(ShareRateLimiter, {
	check: (input) => {
		checked.push(input)
		return Effect.succeed(limited.now ? ("limited" as const) : ("allowed" as const))
	},
})

const { handler, dispose } = HttpRouter.toWebHandler(
	OnCallCalendarRouter.pipe(Layer.provide(Layer.merge(schedules, rateLimiter))),
	{ disableLogger: true },
)
afterAll(() => dispose())

const get = (path: string, method = "GET") =>
	handler(new Request(`https://api.maple.test${path}`, { method }))

describe("OnCallCalendarRouter", () => {
	it("serves the calendar behind a known link as text/calendar, kept out of shared caches and indexes", async () => {
		const response = await get(new URL(onCallCalendarFeedUrl("https://api.maple.test", TOKEN)).pathname)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8")
		expect(response.headers.get("cache-control")).toBe("private, max-age=300")
		expect(response.headers.get("x-robots-tag")).toBe("noindex")
		expect(await response.text()).toBe(CALENDAR)
	})

	it("answers an unknown link, and a path without the .ics ending, with the same bare 404", async () => {
		const unknown = await get("/calendar/oncall/mcal_guess.ics")
		expect(unknown.status).toBe(404)
		expect(await unknown.text()).toBe("Not found")
		expect(unknown.headers.get("cache-control")).toBe("no-store")
		const before = asked.length
		const noSuffix = await get(`/calendar/oncall/${TOKEN}`)
		expect(noSuffix.status).toBe(404)
		// Not a feed path at all: the service is never asked.
		expect(asked).toHaveLength(before)
	})

	it("says to come back later when the database cannot be read, without saying why", async () => {
		const response = await get("/calendar/oncall/mcal_down.ics")
		expect(response.status).toBe(503)
		expect(response.headers.get("retry-after")).toBe("60")
		expect(await response.text()).toBe("Temporarily unavailable")
	})

	it("answers 503, not a feed without names, when the member directory is down", async () => {
		const response = await get("/calendar/oncall/mcal_nodir.ics")
		expect(response.status).toBe(503)
		expect(response.headers.get("retry-after")).toBe("300")
		expect(response.headers.get("content-type")).not.toContain("text/calendar")
	})

	it("refuses a link polled too fast before reading anything, keyed by a hash of the link", async () => {
		limited.now = true
		const before = asked.length
		const response = await get(`/calendar/oncall/${TOKEN}.ics`)
		limited.now = false
		expect(response.status).toBe(429)
		expect(response.headers.get("retry-after")).toBe("60")
		expect(asked).toHaveLength(before)
		const key = checked[checked.length - 1]?.tokenHashPrefix ?? ""
		expect(key).toMatch(/^[0-9a-f]{24}$/)
		expect(key).not.toContain(TOKEN)
	})
})
