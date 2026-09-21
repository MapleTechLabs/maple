/**
 * The one rule in this Worker that is absolute: a customer's conversation never
 * reaches a log line or a span.
 *
 * It is stated in `inbound.ts` and enforced by nothing else. The failure mode is
 * a quiet one-line edit — somebody adds the text to a log to debug a turn and it
 * ships — so the test reads the ACTUAL recorded telemetry and looks for the
 * message, rather than asserting a list of allowed keys that the same edit would
 * simply extend.
 */
import { Context, Effect, Layer, Logger, References, Tracer } from "effect"
import { describe, expect, it } from "vitest"
import { InboundHandler } from "./inbound.ts"
import { testMessage } from "./test-support.ts"

interface Recorded {
	readonly logs: Array<string>
	readonly spans: Array<Tracer.NativeSpan>
}

const record = (): { recorded: Recorded; context: Context.Context<never> } => {
	const logs: Array<string> = []
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	const logger = Logger.make(({ fiber, message }) => {
		logs.push(
			JSON.stringify({
				message,
				annotations: fiber.getRef(References.CurrentLogAnnotations),
			}),
		)
	})
	return {
		recorded: { logs, spans },
		context: Context.make(Tracer.Tracer, tracer).pipe(
			Context.add(Logger.CurrentLoggers, new Set([logger])),
		),
	}
}

const handleAndRecord = async (): Promise<Recorded & { everything: string }> => {
	const { recorded, context } = record()
	await Effect.runPromise(
		Effect.flatMap(InboundHandler, (handler) => handler.handle(testMessage)).pipe(
			Effect.provide(InboundHandler.layer),
			Effect.provideContext(context),
		),
	)
	const everything = JSON.stringify({
		logs: recorded.logs,
		spans: recorded.spans.map((span) => ({
			name: span.name,
			attributes: Object.fromEntries(span.attributes),
		})),
	})
	return { ...recorded, everything }
}

describe("recording an inbound event", () => {
	it("never writes the message text, anywhere", async () => {
		const { everything } = await handleAndRecord()
		expect(testMessage.text).not.toBe("")
		expect(everything).not.toContain(testMessage.text)
		expect(everything).not.toContain(testMessage.author.displayName)
	})

	it("records what the event was, which connector and which workspace", async () => {
		const { everything, spans } = await handleAndRecord()
		expect(everything).toContain(testMessage.connector)
		expect(everything).toContain(testMessage.workspaceId)
		const [span] = spans
		expect(span?.name).toBe("chat_bot.inbound_event")
		expect(Object.fromEntries(span?.attributes ?? new Map())).toMatchObject({
			"maple.chat.event": "message",
			"maple.chat.workspace_id": testMessage.workspaceId,
		})
	})
})
