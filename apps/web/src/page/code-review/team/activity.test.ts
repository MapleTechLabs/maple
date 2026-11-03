import { CodeReviewTeamActivity } from "@maple/domain/http"
import { describe, expect, test } from "vitest"
import { activityByDay, daysOf } from "./activity"

const row = (day: string, login: string, repository: string, opened: number, merged: number) =>
	new CodeReviewTeamActivity({ day, login, repository, opened, merged })

describe("daysOf", () => {
	test("lists every day the window touches in the zone, across a month end", () => {
		expect(daysOf(Date.UTC(2026, 9, 30, 12), Date.UTC(2026, 10, 2, 1), "UTC")).toEqual([
			"2026-10-30",
			"2026-10-31",
			"2026-11-01",
			"2026-11-02",
		])
	})

	test("reads the days in the viewer's zone, through a clock change", () => {
		// 2026-11-01 is the US fall-back day: 25 hours long in New York.
		expect(daysOf(Date.UTC(2026, 10, 1, 3), Date.UTC(2026, 10, 3, 3), "America/New_York")).toEqual([
			"2026-10-31",
			"2026-11-01",
			"2026-11-02",
		])
	})

	test("an empty window has no days", () => {
		expect(daysOf(10, 10, "UTC")).toEqual([])
	})
})

describe("activityByDay", () => {
	test("totals a day and lists its people and repositories busiest first", () => {
		const day = activityByDay([
			row("2026-10-01", "ada", "acme/web", 1, 0),
			row("2026-10-01", "lin", "acme/web", 2, 1),
			row("2026-10-01", "lin", "acme/api", 0, 1),
			row("2026-10-02", "ada", "acme/web", 1, 1),
		]).get("2026-10-01")
		expect(day?.opened).toBe(3)
		expect(day?.merged).toBe(2)
		expect(day?.people.map((person) => [person.key, person.opened, person.merged])).toEqual([
			["lin", 2, 2],
			["ada", 1, 0],
		])
		expect(day?.repositories.map((repository) => repository.key)).toEqual(["acme/web", "acme/api"])
	})
})
