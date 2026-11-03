import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { decodeOAuthReturnHash, encodeOAuthReturnHash } from "./oauth-return"

describe("OAuth return fragment", () => {
	it("carries a provider callback's query to the dashboard intact", () => {
		const query = "code=a%2Bb&state=s-1&installation_id=42"
		const decoded = decodeOAuthReturnHash(encodeOAuthReturnHash({ flow: "github", query }))
		expect(Option.map(decoded, (request) => [request.flow, request.query])).toEqual(
			Option.some(["github", query]),
		)
	})

	it("keeps the chat connector beside the query", () => {
		const decoded = decodeOAuthReturnHash(
			encodeOAuthReturnHash({ flow: "chat_install", connector: "slack", query: "state=s" }),
		)
		expect(Option.map(decoded, (request) => request.connector)).toEqual(Option.some("slack"))
	})

	it("reads nothing from a fragment that is not a return", () => {
		expect(Option.isNone(decodeOAuthReturnHash(""))).toBe(true)
		expect(Option.isNone(decodeOAuthReturnHash("#section-2"))).toBe(true)
		expect(Option.isNone(decodeOAuthReturnHash("#maple_oauth=not-a-flow&q=code%3D1"))).toBe(true)
	})
})
