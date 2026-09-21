/**
 * The review ruleset is an allowlist of concrete names; a name that is not registered would be
 * silently unoffered, and a mutating one would hand an unattended pass a write it cannot get
 * approved.
 */
import { assert, describe, it } from "vitest"
import { evaluatePermission } from "@maple/domain/permission"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"
import { mapleToolCatalog } from "../mcp/tools/registry"
import { AGENTS } from "./agents"
import { PR_REVIEW_RULESET, prReviewToolNames, READ_ONLY_RULESET, rulesetForTurn } from "./permissions"

describe("PR_REVIEW_RULESET", () => {
	const registered = new Set(mapleToolCatalog.map((definition) => definition.name))

	it("names only registered tools", () => {
		for (const name of prReviewToolNames()) {
			assert.isTrue(registered.has(name), `${name} is not a registered tool`)
		}
	})

	it("names no mutating tool", () => {
		for (const name of prReviewToolNames()) {
			assert.isFalse(MUTATING_TOOL_NAMES.has(name), `${name} is mutating`)
		}
	})

	it("offers the diff tools and denies everything it does not name", () => {
		assert.equal(evaluatePermission(PR_REVIEW_RULESET, "pr_changed_files"), "allow")
		assert.equal(evaluatePermission(PR_REVIEW_RULESET, "pr_file_diff"), "allow")
		assert.equal(evaluatePermission(PR_REVIEW_RULESET, "create_alert_rule"), "deny")
		assert.equal(evaluatePermission(PR_REVIEW_RULESET, "list_dashboards"), "deny")
	})
})

describe("rulesetForTurn", () => {
	it("gives the review agent its own ruleset for the unattended pass only", () => {
		const agent = AGENTS["pr-review"]!
		assert.strictEqual(rulesetForTurn(agent, true), PR_REVIEW_RULESET)
		assert.strictEqual(rulesetForTurn(agent, false), agent.permission)
	})

	it("keeps the investigation's unattended pass read-only", () => {
		assert.strictEqual(rulesetForTurn(AGENTS.investigate!, true), READ_ONLY_RULESET)
	})
})
