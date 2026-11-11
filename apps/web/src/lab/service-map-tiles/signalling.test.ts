import { Array as Arr, Option } from "effect"
import { describe, expect, it } from "vitest"
import type { Block } from "./rails"
import {
	farOf,
	homeOf,
	isLoaded,
	type Line,
	makeSignalBox,
	makeTrain,
	signalsOf,
	tailOf,
	type Train,
} from "./signalling"

const line = (blocks: ReadonlyArray<Block> = [], wagons = 1): Line => ({
	length: 12,
	wagons,
	speed: 1,
	blocks,
})

const train = (of: Line, rest = 0): Train => Option.getOrThrow(Option.fromNullishOr(makeTrain(of, rest)))

const STEP = 0.05
const always = () => true
const full = () => 1

/** Whether any part of the train, engine to last wagon, is on track that belongs to `section`. */
const isIn = (subject: Train, section: string): boolean =>
	Arr.some(
		Arr.filter(subject.line.blocks, (block) => block.section === section),
		(block) => subject.along + 0.31 > block.from && subject.along - tailOf(subject.line) < block.to,
	)

/** Runs the box for `seconds`, calling `watch` after every step. */
const runFor = (
	box: ReturnType<typeof makeSignalBox>,
	seconds: number,
	watch: () => void = () => undefined,
	mayLeave: (index: number) => boolean = always,
) =>
	Arr.forEach(Arr.range(1, Math.round(seconds / STEP)), () => {
		box.step(STEP, full, mayLeave)
		watch()
	})

describe("a train alone on its line", () => {
	it("runs to the far station, stands, backs home and sets off again", () => {
		const solo = train(line())
		const box = makeSignalBox([solo])
		const seen = new Set<string>()
		const reach = { far: 0, near: Infinity, top: 0 }
		runFor(box, 60, () => {
			seen.add(solo.phase)
			reach.far = Math.max(reach.far, solo.along)
			reach.near = Math.min(reach.near, solo.along)
			reach.top = Math.max(reach.top, solo.speed)
		})
		expect([...seen].sort()).toEqual(["back", "far", "home", "out"])
		expect(reach.far).toBeCloseTo(farOf(solo.line), 2)
		expect(reach.near).toBeCloseTo(homeOf(solo.line), 2)
		expect(reach.top).toBeLessThanOrEqual(1)
	})

	it("carries its load out and comes home empty", () => {
		const solo = train(line())
		const box = makeSignalBox([solo])
		const loaded = { out: new Set<boolean>(), back: new Set<boolean>() }
		runFor(box, 40, () => {
			if (solo.phase === "out") loaded.out.add(isLoaded(solo))
			if (solo.phase === "back") loaded.back.add(isLoaded(solo))
		})
		expect([...loaded.out]).toEqual([true])
		expect([...loaded.back]).toEqual([false])
	})

	it("needs no signals and never waits", () => {
		const solo = train(line())
		const box = makeSignalBox([solo])
		const waited = { ever: false }
		runFor(box, 40, () => {
			waited.ever = waited.ever || solo.isWaiting
		})
		expect(signalsOf(solo.line)).toEqual([])
		expect(waited.ever).toBe(false)
	})

	it("stands still while it is held", () => {
		const solo = train(line())
		const box = makeSignalBox([solo])
		Arr.forEach(Arr.range(1, 200), () => box.step(STEP, () => 0, always))
		expect(solo.along).toBe(homeOf(solo.line))
		expect(solo.phase).toBe("home")
	})

	it("is not made for a line too short to run on", () => {
		expect(makeTrain({ ...line(), length: 1.5, wagons: 3 }, 0)).toBeNull()
	})
})

describe("two trains over one stretch of track", () => {
	const shared: ReadonlyArray<Block> = [{ section: "middle", from: 4, to: 8 }]

	it("are never both on it, and both get through", () => {
		const [a, b] = [train(line(shared)), train(line(shared))]
		const box = makeSignalBox([a, b])
		const seen = { together: false, aFar: false, bFar: false }
		runFor(box, 180, () => {
			seen.together = seen.together || (isIn(a, "middle") && isIn(b, "middle"))
			seen.aFar = seen.aFar || a.phase === "far"
			seen.bFar = seen.bFar || b.phase === "far"
		})
		expect(seen).toEqual({ together: false, aFar: true, bFar: true })
	})

	it("holds the second at its signal, clear of the stretch, until the first is through", () => {
		const [a, b] = [train(line(shared)), train(line(shared))]
		const box = makeSignalBox([a, b])
		const waits: Array<number> = []
		runFor(box, 30, () => {
			if (b.isWaiting && b.phase === "out") waits.push(b.along)
		})
		expect(waits.length).toBeGreaterThan(0)
		// Its nose stands short of where the shared track begins.
		expect(Math.max(...waits) + 0.31).toBeLessThan(4)
		expect(Math.max(...waits)).toBeGreaterThan(3)
	})

	it("shows the stretch as taken only while a train has the road through it", () => {
		const solo = train(line(shared))
		const box = makeSignalBox([solo])
		const taken = { out: new Set<boolean>(), far: new Set<boolean>() }
		runFor(box, 20, () => {
			if (isIn(solo, "middle") && solo.phase === "out") taken.out.add(box.isOccupied("middle"))
			if (solo.phase === "far") taken.far.add(box.isOccupied("middle"))
		})
		expect([...taken.out]).toEqual([true])
		expect([...taken.far]).toEqual([false])
	})

	it("puts a signal each way at the edges of the stretch", () => {
		const signals = signalsOf(line(shared))
		expect(Arr.map(signals, (signal) => [signal.side, signal.guards])).toEqual([
			[1, ["middle"]],
			[-1, ["middle"]],
		])
		expect(signals[0]?.along).toBeLessThan(4)
		expect(signals[1]?.along).toBeGreaterThan(8)
	})

	it("keeps a train at its platform when the stretch begins inside its station", () => {
		const near: ReadonlyArray<Block> = [{ section: "throat", from: 0.5, to: 3 }]
		const [a, b] = [train(line(near)), train(line(near))]
		const box = makeSignalBox([a, b])
		const waits: Array<number> = []
		runFor(box, 12, () => {
			if (b.isWaiting) waits.push(b.along)
		})
		expect(waits.length).toBeGreaterThan(0)
		expect(new Set(waits)).toEqual(new Set([homeOf(b.line)]))
	})
})

describe("trains that meet each other's track in opposite order", () => {
	// One line crosses "west" and then "east"; the other crosses "east" and then "west".
	const westFirst: ReadonlyArray<Block> = [
		{ section: "west", from: 3, to: 5 },
		{ section: "east", from: 7, to: 9 },
	]
	const eastFirst: ReadonlyArray<Block> = [
		{ section: "east", from: 3, to: 5 },
		{ section: "west", from: 7, to: 9 },
	]

	it("never end up each waiting for the other", () => {
		const [a, b] = [train(line(westFirst)), train(line(eastFirst))]
		const box = makeSignalBox([a, b])
		const trips = { a: 0, b: 0, clash: false }
		const last = { a: a.phase, b: b.phase }
		runFor(box, 400, () => {
			if (a.phase === "far" && last.a !== "far") trips.a += 1
			if (b.phase === "far" && last.b !== "far") trips.b += 1
			last.a = a.phase
			last.b = b.phase
			trips.clash =
				trips.clash || (isIn(a, "west") && isIn(b, "west")) || (isIn(a, "east") && isIn(b, "east"))
		})
		expect(trips.clash).toBe(false)
		expect(trips.a).toBeGreaterThan(3)
		expect(trips.b).toBeGreaterThan(3)
	})

	it("hold nothing while they wait", () => {
		const [a, b] = [train(line(westFirst)), train(line(eastFirst))]
		const box = makeSignalBox([a, b])
		const held = new Set<boolean>()
		runFor(box, 120, () => {
			// With one train waiting, every taken section is the other's.
			if (b.isWaiting) held.add(b.hasRoad)
			if (a.isWaiting) held.add(a.hasRoad)
		})
		expect([...held]).toEqual([false])
	})
})

describe("a train whose link is switched off", () => {
	it("finishes the trip it is on and then stays at home", () => {
		const solo = train(line())
		const box = makeSignalBox([solo])
		runFor(box, 5)
		expect(solo.phase).toBe("out")
		const phases: Array<string> = []
		runFor(
			box,
			60,
			() => phases.push(solo.phase),
			() => false,
		)
		expect(phases).toContain("far")
		expect(phases).toContain("back")
		expect(Arr.takeRight(phases, 400)).toEqual(Arr.makeBy(400, () => "home"))
		expect(solo.along).toBeCloseTo(homeOf(solo.line), 2)
	})
})
