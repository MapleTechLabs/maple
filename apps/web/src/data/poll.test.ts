import { Effect, Queue, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import { backoffPollTicks, pollTicks, type Presence, whenPresent } from "./poll"

/** A presence the test flips, with the change events it would dispatch. */
const fakePresence = Effect.gen(function* () {
	const present = yield* Ref.make(true)
	const changes = yield* Queue.unbounded<void>()
	const presence: Presence = { isPresent: () => Ref.getUnsafe(present), changes: Stream.fromQueue(changes) }
	const set = (isPresent: boolean) => Effect.andThen(Ref.set(present, isPresent), Queue.offer(changes, undefined))
	return { presence, set }
})

const counted = (presence: Presence) =>
	Effect.gen(function* () {
		const ticks = yield* Ref.make(0)
		yield* Effect.forkChild(Stream.runForEach(pollTicks("10 seconds", presence), () => Ref.update(ticks, (n) => n + 1)))
		yield* Effect.yieldNow
		return ticks
	})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

describe("pollTicks", () => {
	test("ticks once per interval, the first after a full interval", () =>
		run(
			Effect.gen(function* () {
				const { presence } = yield* fakePresence
				const ticks = yield* counted(presence)
				expect(yield* Ref.get(ticks)).toBe(0)
				yield* TestClock.adjust("10 seconds")
				expect(yield* Ref.get(ticks)).toBe(1)
				yield* TestClock.adjust("20 seconds")
				expect(yield* Ref.get(ticks)).toBe(3)
			}),
		))

	test("skips ticks while away, and ticks once on return after a skipped one", () =>
		run(
			Effect.gen(function* () {
				const { presence, set } = yield* fakePresence
				const ticks = yield* counted(presence)
				yield* set(false)
				yield* TestClock.adjust("30 seconds")
				expect(yield* Ref.get(ticks)).toBe(0)
				yield* set(true)
				yield* Effect.yieldNow
				expect(yield* Ref.get(ticks)).toBe(1)
			}),
		))

	test("a return before any tick was skipped waits for the next interval", () =>
		run(
			Effect.gen(function* () {
				const { presence, set } = yield* fakePresence
				const ticks = yield* counted(presence)
				yield* set(false)
				yield* TestClock.adjust("5 seconds")
				yield* set(true)
				yield* Effect.yieldNow
				expect(yield* Ref.get(ticks)).toBe(0)
				yield* TestClock.adjust("5 seconds")
				expect(yield* Ref.get(ticks)).toBe(1)
			}),
		))

	test("a regular tick within half an interval of a catch-up is dropped", () =>
		run(
			Effect.gen(function* () {
				const { presence, set } = yield* fakePresence
				const ticks = yield* counted(presence)
				yield* set(false)
				yield* TestClock.adjust("19 seconds")
				yield* set(true)
				yield* Effect.yieldNow
				expect(yield* Ref.get(ticks)).toBe(1)
				// The 20 s tick lands one second after the catch-up and is dropped.
				yield* TestClock.adjust("9 seconds")
				expect(yield* Ref.get(ticks)).toBe(1)
				yield* TestClock.adjust("2 seconds")
				expect(yield* Ref.get(ticks)).toBe(2)
			}),
		))

	test("a regular tick more than half an interval after a catch-up still runs", () =>
		run(
			Effect.gen(function* () {
				const { presence, set } = yield* fakePresence
				const ticks = yield* counted(presence)
				yield* set(false)
				yield* TestClock.adjust("12 seconds")
				yield* set(true)
				yield* Effect.yieldNow
				expect(yield* Ref.get(ticks)).toBe(1)
				yield* TestClock.adjust("8 seconds")
				expect(yield* Ref.get(ticks)).toBe(2)
			}),
		))
})

describe("backoffPollTicks", () => {
	test("ticks at the fast interval for the first ticks, then at the slow one", () =>
		run(
			Effect.gen(function* () {
				const { presence } = yield* fakePresence
				const ticks = yield* Ref.make(0)
				const stream = backoffPollTicks("10 seconds", 3, "1 minute", presence)
				yield* Effect.forkChild(Stream.runForEach(stream, () => Ref.update(ticks, (n) => n + 1)))
				yield* Effect.yieldNow
				yield* TestClock.adjust("30 seconds")
				expect(yield* Ref.get(ticks)).toBe(3)
				yield* TestClock.adjust("59 seconds")
				expect(yield* Ref.get(ticks)).toBe(3)
				yield* TestClock.adjust("1 second")
				expect(yield* Ref.get(ticks)).toBe(4)
				yield* TestClock.adjust("2 minutes")
				expect(yield* Ref.get(ticks)).toBe(6)
			}),
		))
})

describe("whenPresent", () => {
	test("emits at once when present, else only on the first return", () =>
		run(
			Effect.gen(function* () {
				const { presence, set } = yield* fakePresence
				expect(yield* Stream.runCollect(whenPresent(presence))).toEqual([undefined])
				yield* set(false)
				const waits = yield* Ref.make(0)
				yield* Effect.forkChild(Stream.runForEach(whenPresent(presence), () => Ref.update(waits, (n) => n + 1)))
				yield* Effect.yieldNow
				expect(yield* Ref.get(waits)).toBe(0)
				yield* set(true)
				yield* set(false)
				yield* set(true)
				yield* Effect.yieldNow
				expect(yield* Ref.get(waits)).toBe(1)
			}),
		))
})
