import { describe, it } from "@effect/vitest"
import { Effect, Fiber, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse } from "effect/http"
import { expect } from "vitest"
import { MapleSyncHttpClient } from "../../../platform/api-clients"
import { tailEvents } from "./chat-api"

// The live tail's reconnects: a server that closes cleanly must not be re-dialled in a hot loop.

const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`

/** Answers each `/events` request with the next body (the last one repeats), counting the requests. */
const tailWith = (bodies: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const requests = yield* Ref.make(0)
		const client = HttpClient.make((request) =>
			Ref.getAndUpdate(requests, (count) => count + 1).pipe(
				Effect.map((index) =>
					HttpClientResponse.fromWeb(request, new Response(bodies[Math.min(index, bodies.length - 1)], { status: 200 })),
				),
			),
		)
		const outputs = yield* Stream.runCollect(tailEvents("org_acme:default", 0)).pipe(
			Effect.provideService(MapleSyncHttpClient, client),
		)
		return { outputs, requests: yield* Ref.get(requests) }
	})

describe("tailEvents", () => {
	it.live("clean closes that deliver nothing back off and give up after the retry budget", () =>
		Effect.gen(function* () {
			const { outputs, requests } = yield* tailWith([""])
			expect(requests).toBe(4)
			expect(outputs).toEqual([{ _tag: "Failed", message: "Lost connection to chat." }])
		}),
	)

	it.live("a clean close after new events reconnects from the last seq until the turn ends", () =>
		Effect.gen(function* () {
			const { outputs, requests } = yield* tailWith([
				frame({ type: "text-delta", seq: 1, messageId: "r", text: "Hi" }),
				"",
				frame({ type: "turn-end", seq: 2, messageId: "r", reason: "stop" }),
			])
			expect(requests).toBe(3)
			expect(outputs.map((output) => (output._tag === "Events" ? output.events.map((event) => event.type) : output._tag))).toEqual([
				["text-delta"],
				["turn-end"],
			])
		}),
	)

	it.effect("an idle connection the server recycles reconnects without spending the retry budget", () =>
		Effect.gen(function* () {
			const requests = yield* Ref.make(0)
			const turnEnd = frame({ type: "turn-end", seq: 1, messageId: "r", reason: "stop" })
			// Five idle connections, each held open past the quick-close window, then the turn ends.
			const client = HttpClient.make((request) =>
				Ref.getAndUpdate(requests, (count) => count + 1).pipe(
					Effect.flatMap((index) =>
						index < 5 ? Effect.as(Effect.sleep("6 seconds"), "") : Effect.succeed(turnEnd),
					),
					Effect.map((body) => HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))),
				),
			)
			const fiber = yield* Stream.runCollect(tailEvents("org_acme:default", 0)).pipe(
				Effect.provideService(MapleSyncHttpClient, client),
				Effect.forkChild,
			)
			yield* TestClock.adjust("1 minute")
			const outputs = yield* Fiber.join(fiber)
			expect(yield* Ref.get(requests)).toBe(6)
			expect(outputs.map((output) => output._tag)).toEqual(["Events"])
		}),
	)
})
