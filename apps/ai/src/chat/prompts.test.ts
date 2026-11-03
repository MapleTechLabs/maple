/**
 * The prompts, as contracts: the sections every renderer has to agree with stay shared, and the
 * connector persona only names tools that exist.
 */
import { assert, describe, it } from "vitest"
import { mapleToolCatalog } from "../mcp/tools/registry"
import { CONNECTOR_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts"
import { Array as Arr } from "effect"

describe("CONNECTOR_SYSTEM_PROMPT", () => {
	it("carries the sections every renderer has to agree with", () => {
		// The point of lifting them out: one chart contract, one annotation grammar. A fix to the
		// `unit:` line was made twice in a week while these existed in two copies.
		for (const shared of ["```chart", "<<maple:trace:", "- unit: one of number", "## Dashboards"]) {
			assert.include(CONNECTOR_SYSTEM_PROMPT, shared)
			assert.include(SYSTEM_PROMPT, shared)
		}
	})

	it("only sends the agent to sandbox tools that are registered", () => {
		const named = Arr.map(
			[...CONNECTOR_SYSTEM_PROMPT.matchAll(/\bsandbox_[a-z_]+/g)],
			(match) => match[0],
		)
		const registered = new Set(Arr.map(mapleToolCatalog, (tool) => tool.name))
		assert.isNotEmpty(named)
		assert.deepEqual(
			Arr.filter(named, (name) => !registered.has(name)),
			[],
		)
	})

	it("sends nobody to the Maple app, because it can act from the channel", () => {
		assert.notInclude(CONNECTOR_SYSTEM_PROMPT, "Maple app")
	})

	it("drops what does not survive the trip to a channel", () => {
		// No 420px panel, and no markdown tables: the in-app prompt teaches both.
		assert.notInclude(CONNECTOR_SYSTEM_PROMPT, "420px")
	})
})
