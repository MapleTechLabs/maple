import { Result } from "effect"
import { describe, expect, it } from "vitest"
import { dropMetricName, ensureUniqueLabelsets, signature } from "./labels"

describe("signature", () => {
	const a = { __name__: "up", job: "api", instance: "1" }
	const b = { __name__: "down", job: "api", instance: "1" }

	it("ignoring drops __name__ so series of different metrics match", () => {
		expect(signature(a, [], false)).toBe(signature(b, [], false))
		expect(signature(a, ["instance"], false)).toBe(signature({ job: "api" }, [], false))
	})

	it("on keeps only the listed labels", () => {
		expect(signature(a, ["job"], true)).toBe(signature({ job: "api", zone: "x" }, ["job"], true))
		expect(signature(a, ["job"], true)).not.toBe(signature({ job: "web" }, ["job"], true))
	})
})

describe("labels", () => {
	it("dropMetricName removes only __name__", () => {
		expect(dropMetricName({ __name__: "up", job: "api" })).toEqual({ job: "api" })
	})

	it("rejects vectors with repeated label sets", () => {
		const result = ensureUniqueLabelsets([
			{ labels: { a: "1" }, value: 1, t: 0 },
			{ labels: { a: "1" }, value: 2, t: 0 },
		])
		expect(Result.isFailure(result) && result.failure.message).toBe(
			"vector cannot contain metrics with the same labelset",
		)
	})
})
