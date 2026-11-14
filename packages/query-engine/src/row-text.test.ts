import { describe, expect, it } from "vitest"
import { parseProjectedAttributes } from "./row-text"

describe("parseProjectedAttributes", () => {
	it("drops only the keys whose value is empty or not a string", () => {
		expect(
			parseProjectedAttributes('{"http.route":"/a","retries":3,"ok":true,"blank":"","n":null}'),
		).toEqual({
			"http.route": "/a",
		})
	})

	it("reads malformed or missing JSON as an empty map", () => {
		expect([
			parseProjectedAttributes("{not json"),
			parseProjectedAttributes(""),
			parseProjectedAttributes(undefined),
		]).toEqual([{}, {}, {}])
	})
})
