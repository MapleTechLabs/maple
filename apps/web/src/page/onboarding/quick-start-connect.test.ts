import { Effect, Queue, Ref, Result, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import type { Presence } from "../../data/poll"
import * as QuickStart from "./quick-start"
import {
	closeConnect,
	ConnectMessage,
	connectPollTicks,
	connectSubscriptions,
	initConnect,
	openConnect,
	updateConnect,
} from "./quick-start-connect"
import { DEFAULT_QUICK_START_STATE } from "./quick-start-state"

const { onboardingConnectPoll } = connectSubscriptions
const run = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

/** A tab the test hides and shows, with the visibility events it would dispatch. */
const fakeTab = Effect.gen(function* () {
	const visible = yield* Ref.make(true)
	const changes = yield* Queue.unbounded<void>()
	const presence: Presence = { isPresent: () => Ref.getUnsafe(visible), changes: Stream.fromQueue(changes) }
	const show = (isVisible: boolean) =>
		Effect.andThen(Ref.set(visible, isVisible), Queue.offer(changes, undefined))
	return { presence, show }
})

const counted = <A>(stream: Stream.Stream<A>) =>
	Effect.gen(function* () {
		const count = yield* Ref.make(0)
		yield* Effect.forkChild(Stream.runForEach(stream, () => Ref.update(count, (n) => n + 1)))
		yield* Effect.yieldNow
		return count
	})

const open = openConnect(initConnect(), "org_1", ["cloudflare"]).connect

describe("onboarding connect poll", () => {
	test("a visible tab left on the step polls 220 times in its first hour, then stops", () =>
		run(
			Effect.gen(function* () {
				const deps = onboardingConnectPoll.modelToDependencies(open)
				const polls = yield* counted(onboardingConnectPoll.dependenciesToStream(deps))
				yield* TestClock.adjust("10 minutes")
				// Fast while they set up: one every 5 s.
				expect(yield* Ref.get(polls)).toBe(120)
				yield* TestClock.adjust("50 minutes")
				expect(yield* Ref.get(polls)).toBe(220)
				yield* TestClock.adjust("5 hours")
				expect(yield* Ref.get(polls)).toBe(220)
			}),
		))

	test("a hidden tab reads nothing, and reads at once when shown again", () =>
		run(
			Effect.gen(function* () {
				const { presence, show } = yield* fakeTab
				const polls = yield* counted(connectPollTicks(presence))
				yield* show(false)
				yield* TestClock.adjust("30 minutes")
				expect(yield* Ref.get(polls)).toBe(0)
				yield* show(true)
				yield* Effect.yieldNow
				expect(yield* Ref.get(polls)).toBe(1)
			}),
		))

	test("a closed step has no poll, and a tick that lands after it closes reads nothing", () =>
		run(
			Effect.gen(function* () {
				const closed = closeConnect(open)
				const deps = onboardingConnectPoll.modelToDependencies(closed)
				const polls = yield* counted(onboardingConnectPoll.dependenciesToStream(deps))
				yield* TestClock.adjust("1 hour")
				expect(yield* Ref.get(polls)).toBe(0)
				expect(updateConnect(closed, ConnectMessage.ElapsedPoll(), "org_1", []).commands).toEqual([])
			}),
		))

	test("going back from the last screen to the connect step keeps the one poll running", () => {
		const atTeam: QuickStart.Model = {
			...QuickStart.init("maple-onboarding-v6-org_1", false, false, "/", "org_1").model,
			state: {
				...DEFAULT_QUICK_START_STATE,
				activeStep: "team",
				completedSteps: { stack: true, connect: true },
				stack: { languages: ["nodejs"], platforms: ["cloudflare"] },
			},
		}
		const update = (model: QuickStart.Model, message: QuickStart.Message) =>
			QuickStart.update(model, message, true).model
		const live = update(atTeam, QuickStart.Message.ClickedContinue({ step: "team" }))
		// One update closes and reopens the step: the poll's dependencies hold, so foldkit keeps its stream.
		const back = update(live, QuickStart.Message.ClickedBack({ to: "connect" }))
		expect(onboardingConnectPoll.modelToDependencies(live.connect)).toEqual({ isActive: true })
		expect(onboardingConnectPoll.modelToDependencies(back.connect)).toEqual({ isActive: true })
		// A read that lands schedules no poll of its own beside the subscription's.
		const loaded = updateConnect(
			back.connect,
			ConnectMessage.LoadedPresence({ result: Result.succeed({}) }),
			"org_1",
			["cloudflare"],
		)
		expect(loaded.commands).toEqual([])
	})
})
