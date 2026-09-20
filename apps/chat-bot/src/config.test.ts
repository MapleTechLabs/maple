import { describe, expect, it } from "vitest"
import { resolveConnectorConfig, socketConnectors } from "./config.ts"
import { TEST_TOKEN_KEY, testSocketConnector, testWebhookConnector } from "./test-support.ts"

describe("resolving a connector's configuration", () => {
	it("hands over the declared values, trimmed", () => {
		const result = resolveConnectorConfig({ [TEST_TOKEN_KEY]: "  a-token  " }, testSocketConnector())
		expect(result).toEqual({ _tag: "ready", config: new Map([[TEST_TOKEN_KEY, "a-token"]]) })
	})

	it("names what is missing, so a skipped connector says why", () => {
		expect(resolveConnectorConfig({}, testSocketConnector())).toEqual({
			_tag: "missing",
			names: [TEST_TOKEN_KEY],
		})
	})

	it("treats a blank value as absent rather than binding an empty string", () => {
		expect(resolveConnectorConfig({ [TEST_TOKEN_KEY]: "   " }, testSocketConnector())).toEqual({
			_tag: "missing",
			names: [TEST_TOKEN_KEY],
		})
	})

	it("treats a binding that is not a string as absent", () => {
		// A Worker env carries resources as well as configuration, and a name
		// collision would otherwise hand a connector a namespace object.
		for (const value of [42, true, {}, null]) {
			expect(resolveConnectorConfig({ [TEST_TOKEN_KEY]: value }, testSocketConnector())).toEqual(
				{ _tag: "missing", names: [TEST_TOKEN_KEY] },
			)
		}
	})
})

describe("selecting the connectors that need a socket", () => {
	it("leaves the ones whose events arrive over HTTP alone", () => {
		const socket = testSocketConnector()
		expect(socketConnectors([socket, testWebhookConnector()])).toEqual([socket])
	})
})
