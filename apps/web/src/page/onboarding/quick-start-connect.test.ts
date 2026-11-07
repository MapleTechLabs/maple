import { Effect, Layer, Queue, Ref, Result, Schema, Stream } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { HttpClient, HttpClientResponse } from "effect/http"
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
	SendTestTrace,
	updateConnect,
} from "./quick-start-connect"
import { ingestUrl } from "../../lib/services/common/ingest-url"
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

	test("going back from the live screen to the connect step keeps the one poll running", () => {
		const atConnect: QuickStart.Model = {
			...QuickStart.init("maple-onboarding-v6-org_1", false, false, "/", "org_1").model,
			state: {
				...DEFAULT_QUICK_START_STATE,
				activeStep: "connect",
				completedSteps: { stack: true },
				stack: { languages: ["nodejs"], platforms: ["cloudflare"] },
			},
		}
		const update = (model: QuickStart.Model, message: QuickStart.Message) =>
			QuickStart.update(model, message, true).model
		const live = update(atConnect, QuickStart.Message.ClickedContinue({ step: "connect" }))
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

describe("send test trace request", () => {
	const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

	/** Runs the command against a fake ingest that answers `response`, returning what it sent. */
	const send = (response: () => Response) =>
		Effect.gen(function* () {
			const sent = yield* Ref.make<
				ReadonlyArray<{ url: string; auth: string | undefined; body: unknown }>
			>([])
			const http = HttpClient.make((request) =>
				Ref.update(sent, (requests) => [
					...requests,
					{
						url: request.url,
						auth: request.headers.authorization,
						propagated:
							request.headers.b3 !== undefined || request.headers.traceparent !== undefined,
						body:
							request.body._tag === "Uint8Array"
								? decodeJson(new TextDecoder().decode(request.body.body))
								: request.body._tag,
					},
				]).pipe(Effect.as(HttpClientResponse.fromWeb(request, response()))),
			)
			const message = yield* SendTestTrace({ apiKey: "maple_sk_test" }).effect.pipe(
				Effect.provide([Layer.succeed(HttpClient.HttpClient, http), SecureRandom.layerWebCrypto]),
			)
			return { message, requests: yield* Ref.get(sent) }
		}).pipe(Effect.runPromise)

	test("posts one OTLP/JSON server span to ingest with the org's key", async () => {
		const { message, requests } = await send(() => Response.json({}))
		expect(message._tag).toBe("SucceededSendTestTrace")
		expect(requests).toHaveLength(1)
		const [request] = requests
		expect(request?.url).toBe(`${ingestUrl}/v1/traces`)
		expect(request?.auth).toBe("Bearer maple_sk_test")
		// Ingest's CORS does not allow `b3`: a propagated header fails the browser preflight.
		expect(request?.propagated).toBe(false)
		const body = Schema.decodeUnknownSync(
			Schema.Struct({
				resourceSpans: Schema.Tuple([
					Schema.Struct({
						resource: Schema.Struct({ attributes: Schema.Array(Schema.Unknown) }),
						scopeSpans: Schema.Tuple([
							Schema.Struct({
								spans: Schema.Tuple([
									Schema.Struct({
										traceId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
										spanId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/)),
										kind: Schema.Literal(2),
										startTimeUnixNano: Schema.String.check(Schema.isPattern(/^\d{19}$/)),
										endTimeUnixNano: Schema.String.check(Schema.isPattern(/^\d{19}$/)),
									}),
								]),
							}),
						]),
					}),
				]),
			}),
		)(request?.body)
		expect(body.resourceSpans[0].resource.attributes).toContainEqual({
			key: "service.name",
			value: { stringValue: "maple-test" },
		})
	})

	test("a rejected key shows ingest's own message", async () => {
		const regionMessage =
			"Invalid ingest key. Keys are region-specific: if your Maple org is in the EU, send to https://ingest.eu.maple.dev."
		const { message } = await send(() =>
			Response.json(
				{ error: { code: "ingest_unauthorized", message: regionMessage } },
				{ status: 401 },
			),
		)
		expect(message).toEqual(ConnectMessage.FailedSendTestTrace({ message: regionMessage }))
	})

	test("a 200 that dropped the span is a failure, with ingest's reason", async () => {
		const { message } = await send(() =>
			Response.json({ partialSuccess: { rejectedSpans: "1", errorMessage: "span too old" } }),
		)
		expect(message).toEqual(ConnectMessage.FailedSendTestTrace({ message: "span too old" }))
	})
})
