import type { ChatConnector, InboundEvent } from "@maple/chat-platform"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { InboundHandler, type InboundHandlerApi } from "../inbound.ts"
import {
	rejectingWebhookConnector,
	TEST_TOKEN_KEY,
	testMessage,
	testSocketConnector,
	testWebhookConnector,
} from "../test-support.ts"
import { connectorWebhookRouter } from "./webhook.ts"

const post = (path: string) => new Request(`https://chat-bot.test${path}`, { method: "POST" })

const call = async (
	registry: ReadonlyArray<ChatConnector>,
	env: Record<string, unknown>,
	request: Request,
) => {
	const received: Array<InboundEvent> = []
	const inbound: InboundHandlerApi = {
		handle: (event) =>
			Effect.sync(() => {
				received.push(event)
			}),
	}
	const web = HttpRouter.toWebHandler(
		connectorWebhookRouter(env, registry).pipe(
			Layer.provideMerge(Layer.succeed(InboundHandler)(inbound)),
			Layer.provideMerge(HttpRouter.layer),
		),
	)
	const response = await web.handler(request)
	await web.dispose()
	return { response, received }
}

const configured = { [TEST_TOKEN_KEY]: "a-token" }

describe("the generic connector webhook route", () => {
	it("dispatches to the connector named in the path and publishes what it returned", async () => {
		const connector = testWebhookConnector(() =>
			Effect.succeed({
				response: HttpServerResponse.text("accepted", { status: 202 }),
				events: [testMessage],
			}),
		)
		const { response, received } = await call(
			[connector],
			configured,
			post("/connectors/testhook/webhook"),
		)
		expect(response.status).toBe(202)
		expect(received).toEqual([testMessage])
	})

	it("hands the connector its own configuration", async () => {
		let seen: string | undefined
		const connector = testWebhookConnector((config) =>
			Effect.sync(() => {
				seen = config.get(TEST_TOKEN_KEY)
				return { response: HttpServerResponse.text("ok"), events: [] }
			}),
		)
		await call([connector], configured, post("/connectors/testhook/webhook"))
		expect(seen).toBe("a-token")
	})

	it("answers 404 for an id no connector claims", async () => {
		const { response } = await call(
			[testWebhookConnector()],
			configured,
			post("/connectors/nosuch/webhook"),
		)
		expect(response.status).toBe(404)
	})

	it("answers 404 for a connector whose events do not arrive over HTTP", async () => {
		const { response } = await call(
			[testSocketConnector()],
			configured,
			post("/connectors/testchat/webhook"),
		)
		expect(response.status).toBe(404)
	})

	it("answers 503 rather than accepting a payload it cannot verify", async () => {
		const { response } = await call([testWebhookConnector()], {}, post("/connectors/testhook/webhook"))
		expect(response.status).toBe(503)
	})

	it("answers 400 when the connector rejects the payload, and publishes nothing", async () => {
		const { response, received } = await call(
			[rejectingWebhookConnector()],
			configured,
			post("/connectors/testhook/webhook"),
		)
		expect(response.status).toBe(400)
		expect(received).toEqual([])
	})
})
