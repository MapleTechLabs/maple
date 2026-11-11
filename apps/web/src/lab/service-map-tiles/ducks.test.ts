import { Array as Arr, Option } from "effect"
import { describe, expect, it } from "vitest"
import { AWAY, calmDuck, type DuckMood, FLIGHT, HOP, isBack, pokeDuck, STARTLE } from "./ducks"

/** Pokes at each of `times`, returning the duck and what every poke did. */
const pokes = (times: ReadonlyArray<number>) =>
	Arr.reduce(
		times,
		{ duck: calmDuck, outcomes: new Array<Option.Option<{ alarm: boolean }>>() },
		(state, at) => {
			const next = pokeDuck(state.duck, at)
			return { duck: next.duck, outcomes: [...state.outcomes, next.poke] }
		},
	)

const alarms = (times: ReadonlyArray<number>) =>
	Arr.map(pokes(times).outcomes, (poke) => Option.getOrNull(Option.map(poke, (done) => done.alarm)))

describe("poking a duck", () => {
	it("makes it hop, landing a hop later", () => {
		const { duck, poke } = pokeDuck(calmDuck, 10)
		expect(poke).toEqual(Option.some({ seconds: HOP, alarm: false }))
		expect(duck.landsAt).toBeCloseTo(10 + HOP)
		expect(duck.tookOffAt).toBeNull()
	})

	it("scares it off on the last of a run of quick pokes", () => {
		const quick = Arr.makeBy(STARTLE, (index) => index * 0.3)
		expect(alarms(quick)).toEqual([...Arr.makeBy(STARTLE - 1, () => false), true])
		expect(pokes(quick).duck.tookOffAt).toBeCloseTo((STARTLE - 1) * 0.3)
	})

	it("never scares it with pokes that leave it time to settle", () => {
		const slow = Arr.makeBy(STARTLE * 2, (index) => index * 2)
		expect(alarms(slow)).toEqual(Arr.makeBy(STARTLE * 2, () => false))
	})

	it("cannot reach a duck that has flown off", () => {
		const gone: DuckMood = { ...calmDuck, tookOffAt: 5 }
		expect(pokeDuck(gone, 6)).toEqual({ duck: gone, poke: Option.none() })
	})

	it("brings it back once it has flown out, stayed away and glided in", () => {
		const gone: DuckMood = { ...calmDuck, tookOffAt: 100 }
		// Still gliding in a moment before the second flight ends, on the water a moment after.
		expect(isBack(gone, 100 + FLIGHT * 2 + AWAY - 0.1)).toBe(false)
		expect(isBack(gone, 100 + FLIGHT * 2 + AWAY + 0.1)).toBe(true)
		expect(isBack(calmDuck, 1000)).toBe(false)
	})
})
