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
import { CONNECTOR_SYSTEM_PROMPT, INVESTIGATE_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts"

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

describe("the prompts the app and the investigation pass already shipped", () => {
	it.each([
		["SYSTEM_PROMPT", SYSTEM_PROMPT, "402c5f7f6af420f83fe3d3928a8cb41c677d435270cf2f3667f02677b32712cd"],
		[
			"INVESTIGATE_SYSTEM_PROMPT",
			INVESTIGATE_SYSTEM_PROMPT,
			"248ef2385d9e00e888bf26d5a1a367dd9aaa76f07b51a3a81ad319a34633285d",
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

	it("teaches the approval step, and the prohibition on imitating one in prose", () => {
		// Its mutations are gated, so it has to be told — and told not to render the gate itself,
		// which the connector does. The prohibition quotes "[Approve]" on purpose.
		assert.include(CONNECTOR_SYSTEM_PROMPT, "approved before they take effect")
		assert.include(CONNECTOR_SYSTEM_PROMPT, 'NEVER emit "[Approve]"')
	})

	it("sends nobody to the Maple app, because it can act from the channel", () => {
		assert.notInclude(CONNECTOR_SYSTEM_PROMPT, "Maple app")
	})

	it("drops what does not survive the trip to a channel", () => {
		// No 420px panel, and no markdown tables: the in-app prompt teaches both.
		assert.notInclude(CONNECTOR_SYSTEM_PROMPT, "420px")
		assert.include(SYSTEM_PROMPT, "420px")
	})
})
