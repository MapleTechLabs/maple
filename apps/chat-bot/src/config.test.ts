import { describe, expect, it } from "vitest"
import { resolveConnectorConfig, socketConnectors, type IngressConnector } from "./config.ts"
import { TEST_TOKEN_KEY, testSocketConnector, testWebhookConnector } from "./test-support.ts"

/** A connector's own feature switch: declared, not required, and absent on most deployments. */
const TEST_SWITCH_KEY = "MAPLE_TESTCHAT_EXTRA"

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

	it("runs a connector whose OPTIONAL value nobody set", () => {
		// A switch is not a credential. If an absent one counted as missing configuration, adding a
		// feature flag to a connector would take that connector off every deployment that has not
		// set it — which is the whole bot, not the feature.
		const withSwitch: IngressConnector = {
			...testSocketConnector(),
			ingress: {
				...testSocketConnector().ingress,
				requiredConfig: [
					{ name: TEST_TOKEN_KEY, secret: true },
					{ name: TEST_SWITCH_KEY, secret: false, optional: true },
				],
			},
		}

		expect(resolveConnectorConfig({ [TEST_TOKEN_KEY]: "a-token" }, withSwitch)).toEqual({
			_tag: "ready",
			config: new Map([[TEST_TOKEN_KEY, "a-token"]]),
		})
		// And when it IS set, it reaches the connector like any other value.
		expect(
			resolveConnectorConfig({ [TEST_TOKEN_KEY]: "a-token", [TEST_SWITCH_KEY]: "1" }, withSwitch),
		).toEqual({
			_tag: "ready",
			config: new Map([
				[TEST_TOKEN_KEY, "a-token"],
				[TEST_SWITCH_KEY, "1"],
			]),
		})
	})

	it("treats a binding that is not a string as absent", () => {
		// A Worker env carries resources as well as configuration, and a name
		// collision would otherwise hand a connector a namespace object.
		for (const value of [42, true, {}, null]) {
			expect(resolveConnectorConfig({ [TEST_TOKEN_KEY]: value }, testSocketConnector())).toEqual({
				_tag: "missing",
				names: [TEST_TOKEN_KEY],
			})
		}
	})
})

describe("selecting the connectors that need a socket", () => {
	it("leaves the ones whose events arrive over HTTP alone", () => {
		const socket = testSocketConnector()
		expect(socketConnectors([socket, testWebhookConnector()])).toEqual([socket])
	})
})
