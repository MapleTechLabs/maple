/**
 * The prompts, as contracts: the sections every renderer has to agree with stay shared, and the
 * connector persona only names tools that exist.
 */
import { assert, describe, it } from "vitest"
import { mapleToolCatalog, mapleToolCatalogFor } from "../mcp/tools/registry"
import {
	CONNECTOR_ANONYMOUS_SYSTEM_PROMPT,
	CONNECTOR_SYSTEM_PROMPT,
	INVESTIGATE_SYSTEM_PROMPT,
	PR_REVIEW_SYSTEM_PROMPT,
	SYSTEM_PROMPT,
} from "./prompts"
import { Array as Arr, Record as Rec, String as Str } from "effect"

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
			Arr.fromIterable(Str.matchAll(/\bsandbox_[a-z_]+/g)(CONNECTOR_SYSTEM_PROMPT)),
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

describe("CONNECTOR_ANONYMOUS_SYSTEM_PROMPT", () => {
	it("points the model at no tool the turn is not offered", () => {
		const offered = new Set(Arr.map(mapleToolCatalogFor("bot_anonymous"), (tool) => tool.name))
		const named = Arr.filter(mapleToolCatalog, (tool) =>
			new RegExp(`\\b${tool.name}\\b`).test(CONNECTOR_ANONYMOUS_SYSTEM_PROMPT),
		)
		assert.isNotEmpty(named)
		assert.deepEqual(
			Arr.filter(named, (tool) => !offered.has(tool.name)),
			[],
		)
	})
})

describe("agent prompts", () => {
	it("tell every agent that reads telemetry it is data, not instructions", () => {
		const prompts = {
			SYSTEM_PROMPT,
			INVESTIGATE_SYSTEM_PROMPT,
			CONNECTOR_SYSTEM_PROMPT,
			CONNECTOR_ANONYMOUS_SYSTEM_PROMPT,
			PR_REVIEW_SYSTEM_PROMPT,
		}
		const missing = Arr.filter(
			Rec.toEntries(prompts),
			([, prompt]) => !/log bodies[^.]*untrusted data[^.]*never instructions/.test(prompt),
		)
		assert.deepEqual(
			Arr.map(missing, ([name]) => name),
			[],
		)
	})
})
