import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { type Clock, clockOf, daylightAt, elevationAt, hourFor, isSouthernZone, sunTimes } from "./daylight"

const at = (hour: number, day = 80, isSouthern = false): Clock => ({ hour, day, isSouthern })
const hours = Arr.makeBy(96, (index) => index / 4)

describe("the sun", () => {
	it("is up at noon and down at midnight, all year", () => {
		Arr.forEach([1, 80, 172, 265, 355], (day) => {
			expect(elevationAt(at(12.5, day))).toBeGreaterThan(25)
			expect(elevationAt(at(0.5, day))).toBeLessThan(-25)
		})
	})

	it("crosses the horizon at sunrise and sunset", () => {
		const { rise, set } = sunTimes(at(0, 172))
		expect(elevationAt(at(rise, 172))).toBeCloseTo(0, 5)
		expect(elevationAt(at(set, 172))).toBeCloseTo(0, 5)
		expect(elevationAt(at(rise + 0.5, 172))).toBeGreaterThan(0)
		expect(elevationAt(at(rise - 0.5, 172))).toBeLessThan(0)
	})

	it("gives long days in June and short ones in December, the other way round in the south", () => {
		expect(sunTimes(at(0, 172)).length).toBeGreaterThan(15)
		expect(sunTimes(at(0, 355)).length).toBeLessThan(9)
		expect(sunTimes(at(0, 355, true)).length).toBeGreaterThan(15)
		expect(sunTimes(at(0, 172, true)).length).toBeLessThan(9)
	})

	it("stands higher on a summer noon than on a winter one", () => {
		expect(elevationAt(at(12.5, 172))).toBeGreaterThan(elevationAt(at(12.5, 355)) + 20)
	})
})

describe("daylightAt", () => {
	it("names the time of day: night, dawn, day, dusk and night again", () => {
		const named = Arr.dedupeAdjacent(Arr.map(hours, (hour) => daylightAt(at(hour)).timeOfDay))
		expect(named).toEqual(["night", "dawn", "day", "dusk", "night"])
	})

	it("is dark by five on a November evening and light at five on a June one", () => {
		expect(daylightAt(at(17.5, 315)).timeOfDay).toBe("night")
		expect(daylightAt(at(17.5, 172)).timeOfDay).toBe("day")
	})

	it("lights the windows at night and puts them out by day", () => {
		expect(daylightAt(at(0.5)).lamps).toBe(1)
		expect(daylightAt(at(12.5)).lamps).toBe(0)
		const dusk = daylightAt(at(hourFor("dusk", at(0)))).lamps
		expect(dusk).toBeGreaterThan(0)
		expect(dusk).toBeLessThan(1)
	})

	it("is brightest at midday and dimmest at night", () => {
		const power = (hour: number) => daylightAt(at(hour)).sunPower + daylightAt(at(hour)).skyPower
		expect(power(12.5)).toBeGreaterThan(power(hourFor("dusk", at(0))))
		expect(power(hourFor("dusk", at(0)))).toBeGreaterThan(power(0.5))
	})

	it("warms the low sun and cools the moon", () => {
		const [dusk, noon, night] = [
			daylightAt(at(hourFor("dusk", at(0)))),
			daylightAt(at(12.5)),
			daylightAt(at(0.5)),
		]
		// More red than blue at dusk than at noon; more blue than red by moonlight.
		expect(dusk.sun[0] - dusk.sun[2]).toBeGreaterThan(noon.sun[0] - noon.sun[2])
		expect(night.sun[2]).toBeGreaterThan(night.sun[0])
	})

	it("always shines from above the horizon, along a unit vector", () => {
		Arr.forEach(hours, (hour) => {
			const [x, y, z] = daylightAt(at(hour)).direction
			expect(Math.hypot(x, y, z)).toBeCloseTo(1)
			expect(y).toBeGreaterThan(0.15)
		})
	})

	it("moves the sun from one side of the board to the other through the day", () => {
		const { rise, set } = sunTimes(at(0))
		const [morning, evening] = [daylightAt(at(rise + 1)).direction, daylightAt(at(set - 1)).direction]
		expect(morning[0]).toBeLessThan(-0.5)
		expect(evening[0]).toBeGreaterThan(0.5)
	})

	it("turns the light from the sun's side to the moon's only while it is all but out", () => {
		const { set } = sunTimes(at(0))
		// Minute by minute from sunset on: the sun no longer crosses the board, so any turn of
		// the light is the hand-over to the moon.
		const minutes = Arr.map(Arr.range(0, 180), (minute) => daylightAt(at(set + minute / 60)))
		const turns = Arr.flatMap(Arr.zip(minutes, Arr.drop(minutes, 1)), ([before, after]) => {
			const cosine = Arr.reduce([0, 1, 2], 0, (sum, axis) => {
				return sum + (before.direction[axis] ?? 0) * (after.direction[axis] ?? 0)
			})
			const degrees = (Math.acos(Math.min(1, cosine)) * 180) / Math.PI
			return degrees > 0.05 ? [{ degrees, direct: Math.max(before.direct, after.direct) }] : []
		})
		expect(turns.length).toBeGreaterThan(5)
		expect(Math.max(...Arr.map(turns, (turn) => turn.direct))).toBeLessThan(0.3)
		// A little at a time: no minute turns it far.
		expect(Math.max(...Arr.map(turns, (turn) => turn.degrees))).toBeLessThan(12)
		const [first, last] = [minutes[0], minutes[minutes.length - 1]]
		expect(first?.direct).toBeGreaterThan(0.3)
		expect(last?.direct).toBe(1)
	})

	it("never changes the light much from one quarter of an hour to the next", () => {
		const jumps = Arr.map(Arr.zip(hours, Arr.drop(hours, 1)), ([before, after]) => {
			const [a, b] = [daylightAt(at(before)), daylightAt(at(after))]
			return Math.abs(a.sunPower - b.sunPower) + Math.abs(a.skyPower - b.skyPower)
		})
		expect(Math.max(...jumps)).toBeLessThan(0.75)
	})
})

describe("held times of day", () => {
	it("stand for an hour that looks like their name, in any season", () => {
		Arr.forEach([1, 80, 172, 265, 355], (day) => {
			const named = Arr.map(
				["dawn", "day", "dusk", "night"] as const,
				(mode) => daylightAt(at(hourFor(mode, at(0, day)), day)).timeOfDay,
			)
			expect(named).toEqual(["dawn", "day", "dusk", "night"])
		})
	})

	it("leave the clock's own hour alone", () => {
		expect(hourFor("clock", at(7.75))).toBe(7.75)
	})
})

describe("clockOf", () => {
	it("reads the hour with its minutes, and the day of the year", () => {
		const clock = clockOf(new Date(2026, 10, 11, 17, 45), "Europe/Berlin")
		expect(clock).toEqual({ hour: 17.75, day: 315, isSouthern: false })
	})

	it("knows a southern time zone by its name", () => {
		expect(clockOf(new Date(2026, 0, 1, 12, 0), "Australia/Sydney").isSouthern).toBe(true)
		expect(clockOf(new Date(2026, 0, 1, 12, 0), "America/New_York").isSouthern).toBe(false)
	})
})

describe("isSouthernZone", () => {
	it.each([
		"Africa/Blantyre",
		"Africa/Nairobi",
		"America/Cuiaba",
		"America/Buenos_Aires",
		"America/Argentina/Ushuaia",
		"Asia/Jakarta",
		"Indian/Mauritius",
		"Pacific/Auckland",
		"Antarctica/Troll",
	])("places %s south of the equator", (zone) => {
		expect(isSouthernZone(zone)).toBe(true)
	})

	it.each([
		"Europe/Berlin",
		"Africa/Lagos",
		"America/Boa_Vista",
		"Asia/Singapore",
		"Pacific/Honolulu",
		"UTC",
	])("places %s north of it", (zone) => {
		expect(isSouthernZone(zone)).toBe(false)
	})
})
