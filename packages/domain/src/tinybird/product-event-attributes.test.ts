import { describe, expect, it } from "vitest"
import {
	PRODUCT_EVENTS_TRACE_PROJECTION_SQL,
	PRODUCT_EVENT_ATTRIBUTE_NAMESPACE,
	PRODUCT_EVENT_INCLUDE_KEY,
	PRODUCT_EVENT_PROP_PREFIX,
} from "./product-event-attributes"
import { productEvents } from "./datasources"

describe("product event span attributes", () => {
	it("casts the base map to the target key type", () => {
		// Not cosmetic: `SpanAttributes` is keyed `LowCardinality(String)` and
		// `product_events.Attributes` is keyed plain `String`. Without the CAST the
		// MV's SELECT has a different type from the column it writes, and
		// `mapUpdate` has two differently-keyed maps to merge.
		expect(PRODUCT_EVENTS_TRACE_PROJECTION_SQL).toMatch(
			/mapUpdate\(\s*CAST\([\s\S]*SpanAttributes\s*\),\s*'Map\(String, String\)'\s*\),/,
		)
	})

	it("switches the allow-list on key PRESENCE, not on a non-empty value", () => {
		// `include: ''` must mean "no span attributes"; a `!= ''` would silently
		// turn the documented overwrite into copy-everything.
		expect(PRODUCT_EVENTS_TRACE_PROJECTION_SQL).toContain(
			`has(mapKeys(SpanAttributes), '${PRODUCT_EVENT_INCLUDE_KEY}')`,
		)
		expect(PRODUCT_EVENTS_TRACE_PROJECTION_SQL).not.toContain(
			`SpanAttributes['${PRODUCT_EVENT_INCLUDE_KEY}'] != ''`,
		)
	})

	it("trims the allow-list entries", () => {
		// `"plan, seats"` is what a human writes. Without the trim the second key
		// never matches and the prop silently vanishes from every event.
		expect(PRODUCT_EVENTS_TRACE_PROJECTION_SQL).toMatch(
			/arrayMap\(\s*key -> trimBoth\(key\),\s*splitByChar\(',', SpanAttributes\[/,
		)
	})

	it("strips exactly the prop prefix and nothing more", () => {
		// ClickHouse `substring` is 1-indexed, so the offset is length + 1; off by
		// one either way silently yields a valid map with wrong keys.
		const offset = /substring\(k, (\d+)\)/.exec(PRODUCT_EVENTS_TRACE_PROJECTION_SQL)?.[1]
		expect(offset).toBe(String(PRODUCT_EVENT_PROP_PREFIX.length + 1))
	})

	it("merges props over the base so an explicit prop wins a collision", () => {
		// Argument order in `mapUpdate(base, props)` IS the override rule. Swapped,
		// a team overriding a derived value would find their override discarded
		// exactly when the key they wanted to correct was already present.
		const merge = /mapUpdate\(\s*CAST\(/.exec(PRODUCT_EVENTS_TRACE_PROJECTION_SQL)
		expect(merge, "props must be the SECOND mapUpdate argument").not.toBeNull()
		expect(PRODUCT_EVENTS_TRACE_PROJECTION_SQL.indexOf("mapApply")).toBeGreaterThan(
			PRODUCT_EVENTS_TRACE_PROJECTION_SQL.indexOf("mapUpdate"),
		)
	})

	it("keeps the control namespace out of the copied attributes", () => {
		// Once `prop.*` exists, leaving the namespace in means every explicit prop
		// appears twice — as `plan` from the merge and as
		// `maple.product_event.prop.plan` from the base — and name/user_id
		// duplicate columns this same SELECT already promotes.
		expect(PRODUCT_EVENTS_TRACE_PROJECTION_SQL).toContain(
			`NOT startsWith(k, '${PRODUCT_EVENT_ATTRIBUTE_NAMESPACE}')`,
		)
	})

	it("projects the product_events columns in schema order", () => {
		// The MV body is checked structurally by materialized-projection-order,
		// which reads the generated manifest. This asserts the same thing about the
		// shared constant itself, so a bad edit fails before the manifest is
		// regenerated rather than after.
		//
		// Split on TOP-LEVEL commas only. A line-wise scan was enough while every
		// projected column was one line; `Attributes` is now a nested expression
		// whose inner `mapFilter`/`arrayMap` lambdas contain both commas and bare
		// identifiers, and a naive scan reads `k` and `SpanAttributes` as columns.
		const topLevelParts = (input: string): ReadonlyArray<string> => {
			const parts: string[] = []
			let start = 0
			let depth = 0
			let inString = false
			for (let index = 0; index < input.length; index++) {
				const char = input[index]
				if (char === "'" && input[index - 1] !== "\\") {
					inString = !inString
					continue
				}
				if (inString) continue
				if (char === "(") depth++
				if (char === ")") depth--
				if (char === "," && depth === 0) {
					parts.push(input.slice(start, index))
					start = index + 1
				}
			}
			parts.push(input.slice(start))
			return parts.map((part) => part.trim()).filter((part) => part.length > 0)
		}

		const projected = topLevelParts(PRODUCT_EVENTS_TRACE_PROJECTION_SQL).map((part) => {
			const aliased = /\bAS ([A-Za-z][A-Za-z0-9_]*)$/.exec(part)
			return aliased ? aliased[1]! : part
		})
		expect(projected).toEqual(Object.keys(productEvents._schema))
	})
})
