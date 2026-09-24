import type { InboundEvent, SocketStep } from "@maple/chat-platform"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { InboundHandler, type InboundHandlerApi } from "../inbound.ts"
import { TEST_SOCKET_ID, testMessage } from "../test-support.ts"
import { applyStep, reconnectDelayMs, RECONNECT_MAX_MS, type SocketPorts } from "./driver.ts"

/** What the host did, in the order it did it — which is the part that matters. */
interface Recorder {
	readonly trace: Array<string>
	readonly requests: Array<HttpClientRequest.HttpClientRequest>
	readonly events: Array<InboundEvent>
	readonly ports: SocketPorts
	readonly layer: Layer.Layer<HttpClient.HttpClient | InboundHandler>
}

const recorder = (status = 204): Recorder => {
	const trace: Array<string> = []
	const requests: Array<HttpClientRequest.HttpClientRequest> = []
	const events: Array<InboundEvent> = []

	const ports: SocketPorts = {
		connectorId: TEST_SOCKET_ID,
		sink: {
			send: (frame) => {
				trace.push(`send:${frame}`)
			},
		},
		store: {
			write: (state) =>
				Effect.sync(() => {
					trace.push(`store:${state}`)
				}),
		},
	}

	const client = HttpClient.make((request) => {
		requests.push(request)
		trace.push(`request:${request.url}`)
		return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })))
	})

	const inbound: InboundHandlerApi = {
		handle: (event) =>
			Effect.sync(() => {
				events.push(event)
				trace.push(`event:${event.type}`)
			}),
	}

	return {
		trace,
		requests,
		events,
		ports,
		layer: Layer.mergeAll(
			Layer.succeed(HttpClient.HttpClient)(client),
			Layer.succeed(InboundHandler)(inbound),
		),
	}
}

const run = (target: Recorder, step: SocketStep<string>) =>
	Effect.runPromise(applyStep(target.ports, step).pipe(Effect.provide(target.layer)))

describe("applying a connector's step", () => {
	it("writes frames, acknowledges, persists, then publishes — in that order", async () => {
		const target = recorder()
		await run(target, {
			state: '{"seen":1}',
			send: ["first", "second"],
			requests: [
				{
					method: "POST",
					url: "https://platform.test/ack",
					headers: new Map([["content-type", "application/json"]]),
					body: "{}",
				},
			],
			events: [testMessage],
		})
		expect(target.trace).toEqual([
			"send:first",
			"send:second",
			"request:https://platform.test/ack",
			'store:{"seen":1}',
			"event:message",
		])
	})

	it("sends the request the connector described, verbatim", async () => {
		const target = recorder()
		await run(target, {
			state: "{}",
			requests: [
				{
					method: "PATCH",
					url: "https://platform.test/thing",
					headers: new Map([["content-type", "application/json"]]),
					body: '{"type":6}',
				},
			],
		})
		const [request] = target.requests
		expect(request?.method).toBe("PATCH")
		expect(request?.headers["content-type"]).toBe("application/json")
	})

	it("keeps the connection when an acknowledgement is rejected", async () => {
		const target = recorder(500)
		await run(target, {
			state: "{}",
			requests: [
				{
					method: "POST",
					url: "https://platform.test/ack",
					headers: new Map(),
					body: "{}",
				},
			],
			events: [testMessage],
		})
		// The rejection is logged, not raised: the state is still stored and the
		// event still reaches the handler.
		expect(target.events).toEqual([testMessage])
	})

	it("persists the state even when a step does nothing else", async () => {
		const target = recorder()
		await run(target, { state: '{"seen":9}' })
		expect(target.trace).toEqual(['store:{"seen":9}'])
	})
})

describe("reconnect backoff", () => {
	it("doubles from a second and stops at a minute", () => {
		expect(reconnectDelayMs(0)).toBe(1_000)
		expect(reconnectDelayMs(1)).toBe(2_000)
		expect(reconnectDelayMs(4)).toBe(16_000)
		expect(reconnectDelayMs(20)).toBe(RECONNECT_MAX_MS)
	})
})
