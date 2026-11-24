import { afterAll, describe, expect, it } from "@effect/vitest"
import { AlertPersistenceError } from "@maple/domain/http"
import { Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/http"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { onCallCalendarFeedUrl, OnCallCalendarRouter } from "./oncall-calendar.http"

const TOKEN = "mcal_known"
const CALENDAR = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"
const asked: Array<string> = []

/** One feed exists, behind `TOKEN`; `mcal_down` stands for a database that cannot be read. */
const schedules = Layer.mock(OnCallSchedulesService)({
	calendarFeed: (token) => {
		asked.push(token)
		if (token === "mcal_down")
			return Effect.fail(new AlertPersistenceError({ message: "Alert persistence failed" }))
		return Effect.succeed(token === TOKEN ? Option.some(CALENDAR) : Option.none())
	},
})

const { handler, dispose } = HttpRouter.toWebHandler(OnCallCalendarRouter.pipe(Layer.provide(schedules)), {
	disableLogger: true,
})
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
})
