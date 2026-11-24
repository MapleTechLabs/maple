import { afterEach, describe, expect, it } from "vitest"
import { debugIdsOf, resetDebugIdsForTests } from "./debug-ids"
import { InMemorySpanExporter, SimpleSpanProcessor } from "./sdk/testing"
import { TracerProvider } from "./sdk/tracer"

const owner: Record<string, unknown> = globalThis

const APP = "https://cdn.test/assets/app-1a2b.js"
const VENDOR = "https://cdn.test/assets/vendor-9f8e.js?v=3"
const APP_ID = "11111111-1111-4111-8111-111111111111"
const VENDOR_ID = "22222222-2222-4222-8222-222222222222"

const v8Key = (url: string) => `Error\n    at ${url}:1:345\n    at https://cdn.test/assets/loader.js:9:9`

afterEach(() => {
	delete owner._mapleDebugIds
	delete owner._sentryDebugIds
	resetDebugIdsForTests()
})

describe("debugIdsOf", () => {
	it("reads the file URL from V8, Firefox and Safari registration stacks", () => {
		owner._mapleDebugIds = {
			[v8Key(APP)]: APP_ID,
			[`@${VENDOR}:1:12\n`]: VENDOR_ID,
			"global code@https://cdn.test/assets/safari.js:1:88": "33333333-3333-4333-8333-333333333333",
		}
		const stack = [
			"TypeError: boom",
			`    at render (${APP}:4:10)`,
			`handler@${VENDOR}:2:3`,
			"global code@https://cdn.test/assets/safari.js:7:1",
		].join("\n")

		expect(debugIdsOf(stack)).toBe(
			JSON.stringify({
				[APP]: APP_ID,
				[VENDOR]: VENDOR_ID,
				"https://cdn.test/assets/safari.js": "33333333-3333-4333-8333-333333333333",
			}),
		)
	})

	it("keeps a query string as part of the URL", () => {
		owner._mapleDebugIds = { [v8Key(VENDOR)]: VENDOR_ID }

		expect(debugIdsOf(`Error\n    at ${VENDOR}:1:1`)).toBe(JSON.stringify({ [VENDOR]: VENDOR_ID }))
		expect(debugIdsOf("Error\n    at https://cdn.test/assets/vendor-9f8e.js:1:1")).toBeUndefined()
	})

	it("includes only scripts that appear in the stack", () => {
		owner._mapleDebugIds = { [v8Key(APP)]: APP_ID, [v8Key(VENDOR)]: VENDOR_ID }

		expect(debugIdsOf(`Error\n    at f (${APP}:1:1)`)).toBe(JSON.stringify({ [APP]: APP_ID }))
		expect(debugIdsOf("Error\n    at f (https://cdn.test/other.js:1:1)")).toBeUndefined()
	})

	it("is absent when nothing is registered", () => {
		expect(debugIdsOf(`Error\n    at f (${APP}:1:1)`)).toBeUndefined()
	})

	it("picks up a chunk registered after the first lookup", () => {
		const registry = { [v8Key(APP)]: APP_ID }
		owner._mapleDebugIds = registry
		const stack = `Error\n    at f (${APP}:1:1)\n    at g (${VENDOR}:1:1)`
		expect(debugIdsOf(stack)).toBe(JSON.stringify({ [APP]: APP_ID }))

		registry[v8Key(VENDOR)] = VENDOR_ID

		expect(debugIdsOf(stack)).toBe(JSON.stringify({ [APP]: APP_ID, [VENDOR]: VENDOR_ID }))
	})

	it("reads Sentry's registry too, Maple's winning for the same script", () => {
		owner._sentryDebugIds = { [v8Key(APP)]: "sentry-app", [v8Key(VENDOR)]: VENDOR_ID }
		owner._mapleDebugIds = { [`${v8Key(APP)}\n    at extra.js:1:1`]: APP_ID }

		expect(debugIdsOf(`Error\n    at f (${APP}:1:1)\n    at ${VENDOR}:2:2`)).toBe(
			JSON.stringify({
				[APP]: APP_ID,
				[VENDOR]: VENDOR_ID,
			}),
		)
	})

	it("ignores malformed registries and entries", () => {
		owner._sentryDebugIds = "not a registry"
		owner._mapleDebugIds = { [v8Key(APP)]: 42, "no frames here": VENDOR_ID }

		expect(debugIdsOf(`Error\n    at f (${APP}:1:1)`)).toBeUndefined()
	})
})

describe("recordException", () => {
	it("puts the debug ids on the exception event", () => {
		owner._mapleDebugIds = { [v8Key(APP)]: APP_ID }
		const exporter = new InMemorySpanExporter()
		const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] })
		const span = provider.getTracer("test").startSpan("failure")
		span.recordException({
			name: "TypeError",
			message: "boom",
			stack: `TypeError: boom\n    at ${APP}:1:1`,
		})
		span.recordException({ name: "TypeError", message: "elsewhere", stack: "TypeError\n    at x.js:1:1" })
		span.end()

		const [registered, unregistered] = exporter.getFinishedSpans()[0]?.events ?? []
		expect(registered?.attributes?.["maple.exception.debug_ids"]).toBe(
			JSON.stringify({
				[APP]: APP_ID,
			}),
		)
		expect(unregistered?.attributes).not.toHaveProperty("maple.exception.debug_ids")
	})
})
