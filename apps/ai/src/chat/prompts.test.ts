/**
 * The prompts, as contracts.
 *
 * Two different jobs here. The hashes pin that composing the shared sections changed nothing a
 * model reads: `SYSTEM_PROMPT` and `INVESTIGATE_SYSTEM_PROMPT` are byte-for-byte what they were
 * before the sections were lifted out, and a later edit to a shared section that reaches them has
 * to be an edit someone meant to make. The rest are the connector persona's own invariants.
 *
 * The digests were taken from these two strings as they stood before the refactor. Changing a
 * prompt is allowed — updating the digest in the same commit is what makes it deliberate.
 */
import { createHash } from "node:crypto"
import { assert, describe, it } from "vitest"
import { mapleToolCatalog } from "../mcp/tools/registry"
import { CONNECTOR_SYSTEM_PROMPT, INVESTIGATE_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts"

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

describe("the prompts the app and the investigation pass already shipped", () => {
	it.each([
		["SYSTEM_PROMPT", SYSTEM_PROMPT, "3e7ff9ab34673e959d233d891c07ec64854e8443fe94bb55cdfe363e14ae86a2"],
		[
			"INVESTIGATE_SYSTEM_PROMPT",
			INVESTIGATE_SYSTEM_PROMPT,
			"fd417ed6863dd0ebdb8037edde1ee213be5bcd2aeae0025932a27e1ff27c0ed8",
		],
	])("composes %s byte-for-byte as it was", (_name, prompt, digest) => {
		assert.equal(sha256(prompt), digest)
	})
})

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
		const named = [...CONNECTOR_SYSTEM_PROMPT.matchAll(/\bsandbox_[a-z_]+/g)].map((match) => match[0])
		const registered = new Set(mapleToolCatalog.map((tool) => tool.name))
		assert.isNotEmpty(named)
		assert.deepEqual(
			named.filter((name) => !registered.has(name)),
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
