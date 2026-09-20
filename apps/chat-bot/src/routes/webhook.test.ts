import type { ChatConnector, InboundEvent } from "@maple/chat-platform"
import { makeChatConnectorId } from "@maple/chat-platform"
import { Context, Effect, Exit, Layer, Tracer } from "effect"
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

/** The route's span, with the exit it closed on — which is what decides Ok vs Error. */
interface EndedSpan {
	readonly name: string
	readonly attributes: ReadonlyMap<string, unknown>
	readonly exit: Exit.Exit<unknown, unknown>
}

const capturingTracer = () => {
	const ended: Array<EndedSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const attributes = new Map<string, unknown>()
			const span: Tracer.Span = {
				_tag: "Span",
				name: options.name,
				traceId: "test-trace",
				spanId: `test-span-${ended.length}`,
				parent: options.parent,
				annotations: options.annotations,
				links: options.links,
				sampled: options.sampled,
				kind: options.kind,
				status: { _tag: "Started", startTime: options.startTime },
				attributes,
				end(_endTime, exit) {
					ended.push({ name: span.name, attributes, exit })
				},
				attribute(key, value) {
					attributes.set(key, value)
				},
				event() {},
				addLinks() {},
			}
			return span
		},
	})
	return { ended, context: Context.make(Tracer.Tracer, tracer) }
}

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
	const { ended, context } = capturingTracer()
	const web = HttpRouter.toWebHandler(
		connectorWebhookRouter(env, registry).pipe(
			Layer.provideMerge(Layer.succeed(InboundHandler)(inbound)),
			Layer.provideMerge(HttpRouter.layer),
			Layer.provideMerge(Layer.succeedContext(context)),
		),
	)
	const response = await web.handler(request)
	await web.dispose()
	const span = ended.find((candidate) => candidate.name === "chat_bot.connector_webhook")
	return { response, received, span }
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

	it("publishes events in the order the connector reported them", async () => {
		const second = { ...testMessage, messageId: "message-2" }
		const connector = testWebhookConnector(() =>
			Effect.succeed({
				response: HttpServerResponse.text("ok"),
				events: [testMessage, second],
			}),
		)
		const { received } = await call(
			[connector],
			configured,
			post("/connectors/testhook/webhook"),
		)
		expect(received.map((event) => (event.type === "message" ? event.messageId : ""))).toEqual([
			"message-1",
			"message-2",
		])
	})

	it("dispatches to the right connector when several are registered", async () => {
		const other = { ...testWebhookConnector(), id: makeChatConnectorId("otherhook") }
		const { response } = await call(
			[other, testWebhookConnector(() => Effect.succeed({ response: HttpServerResponse.text("ok", { status: 202 }), events: [] }))],
			configured,
			post("/connectors/testhook/webhook"),
		)
		expect(response.status).toBe(202)
	})
})

/**
 * The repo's rule, defended: only a 5xx closes a server span as an error. A
 * rejected caller is a request this service handled correctly.
 */
describe("what the route's span says happened", () => {
	it("leaves a rejected caller's span Ok, with the reason annotated", async () => {
		for (const [connector, path, status, errorType] of [
			[testWebhookConnector(), "/connectors/nosuch/webhook", 404, "ConnectorNotFound"],
			[
				rejectingWebhookConnector(),
				"/connectors/testhook/webhook",
				400,
				"@maple/chat-platform/ConnectorIngressError",
			],
		] as const) {
			const { response, span } = await call([connector], configured, post(path))
			expect(response.status).toBe(status)
			expect(span && Exit.isSuccess(span.exit)).toBe(true)
			expect(Object.fromEntries(span?.attributes ?? new Map())).toMatchObject({
				"error.type": errorType,
				"http.response.status_code": status,
			})
		}
	})

	it("fails the span on the 503, because an unconfigured connector is this service's problem", async () => {
		const { response, span } = await call(
			[testWebhookConnector()],
			{},
			post("/connectors/testhook/webhook"),
		)
		expect(response.status).toBe(503)
		expect(span && Exit.isFailure(span.exit)).toBe(true)
		expect(Object.fromEntries(span?.attributes ?? new Map())).toMatchObject({
			"error.type": "@maple/chat-bot/ConnectorUnavailable",
			"http.response.status_code": 503,
		})
	})

	it("names the connector that was asked for, even when there is no such connector", async () => {
		const { span } = await call([testWebhookConnector()], configured, post("/connectors/nosuch/webhook"))
		expect(span?.attributes.get("maple.chat.connector")).toBe("nosuch")
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
