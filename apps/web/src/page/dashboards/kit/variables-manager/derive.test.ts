import { String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { draftError } from "./derive"
import type { Variable } from "./model"

const promql = (label: string, match?: string): Variable => ({
	name: "instance",
	type: "query",
	source: match === undefined ? { kind: "promql", label } : { kind: "promql", label, match },
})

const errorOf = (draft: Variable) => draftError(draft, 0, [draft])

describe("draftError on a Prometheus label source", () => {
	it("accepts a label and selector within the limits the options query takes", () => {
		expect(errorOf(promql(Str.repeat(256)("a"), `up{x="${Str.repeat(4088)("y")}"}`))).toBeNull()
	})

	it("refuses an empty, dotted or over-long label", () => {
		expect(errorOf(promql(""))).toMatch(/Name the Prometheus label/)
		expect(errorOf(promql("service.name"))).toMatch(/Labels start with a letter/)
		expect(errorOf(promql(Str.repeat(257)("a")))).toMatch(/up to 256 characters/)
	})

	it("refuses a selector over 4096 characters", () => {
		expect(errorOf(promql("instance", `up{x="${Str.repeat(4089)("y")}"}`))).toMatch(/4096 characters/)
	})
})
