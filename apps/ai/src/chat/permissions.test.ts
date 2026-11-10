/**
 * The rulesets against the registry they are built from. The review ruleset is an allowlist of
 * concrete names: an unregistered one would be silently unoffered, a mutating one unapprovable.
 */
import { assert, describe, expect, it } from "vitest"
import { evaluatePermission, isToolVisible } from "@maple/domain/permission"
import { mapleToolCatalog } from "../mcp/tools/registry"
import { AGENTS, type AgentDefinition } from "./agents"
import { CHAT_BUDGET } from "./budgets"
import {
	DEFAULT_RULESET,
	MUTATING_TOOL_NAMES,
	PR_REVIEW_RULESET,
	PR_REVIEW_TOOLS,
	READ_ONLY_RULESET,
} from "./permissions"
import { profileForTurn } from "./profiles"
import { Array as Arr } from "effect"

describe("PR_REVIEW_RULESET", () => {
	const registered = new Set(Arr.map(mapleToolCatalog, (definition) => definition.name))

	it("names only registered tools", () => {
		for (const name of PR_REVIEW_TOOLS) {
			assert.isTrue(registered.has(name), `${name} is not a registered tool`)
		}
	})

	it("names no mutating tool", () => {
		for (const name of PR_REVIEW_TOOLS) {
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

describe("profileForTurn for the reviewer", () => {
	it("gives the review agent its own ruleset for the unattended pass only", () => {
		const agent = AGENTS["pr-review"]
		assert.strictEqual(profileForTurn(agent, { kind: "autonomous" }).ruleset, PR_REVIEW_RULESET)
		assert.strictEqual(profileForTurn(agent, { kind: "app" }).ruleset, agent.permission)
	})

	it("keeps the investigation's unattended pass read-only", () => {
		assert.strictEqual(
			profileForTurn(AGENTS.investigate, { kind: "autonomous" }).ruleset,
			READ_ONLY_RULESET,
		)
	})
})

describe("DEFAULT_RULESET", () => {
	it("asks before every tool that changes data and allows every other", () => {
		// If either side drifts, this fails loudly rather than quietly widening what the chat agent
		// can do without approval.
		for (const definition of mapleToolCatalog) {
			expect(
				evaluatePermission(DEFAULT_RULESET, definition.name),
				`permission drifted for ${definition.name}`,
			).toBe(definition.hints.readOnly ? "allow" : "ask")
		}
	})

	it("hides nothing — the gate is approval, not invisibility", () => {
		for (const definition of mapleToolCatalog) {
			expect(isToolVisible(DEFAULT_RULESET, definition.name)).toBe(true)
		}
	})
})

describe("READ_ONLY_RULESET", () => {
	it("denies every mutating tool, so a sub-agent cannot even see one", () => {
		for (const name of MUTATING_TOOL_NAMES) {
			expect(evaluatePermission(READ_ONLY_RULESET, name), `${name} was visible`).toBe("deny")
		}
	})

	it("allows the read-only tools an investigator actually needs", () => {
		for (const name of ["find_errors", "search_traces", "list_services", "query_data"]) {
			expect(evaluatePermission(READ_ONLY_RULESET, name), `${name} was denied`).toBe("allow")
		}
	})

	it("denies a tool that does not exist yet, rather than matching it by glob", () => {
		// An allowlist of concrete names, not `deny "*"` plus `allow "get_*"`: a mutating tool added
		// next month is denied by default instead of slipping through whatever glob fits its name.
		expect(evaluatePermission(READ_ONLY_RULESET, "get_and_then_delete_everything")).toBe("deny")
	})

	it("never asks — a sub-agent turn has no way to surface an approval card", () => {
		// Approval ends the *outer* turn and is applied by `POST /internal/chat/apply`; a nested turn has
		// no such exit, so an `ask` in a sub-agent ruleset is a configuration error.
		for (const definition of mapleToolCatalog) {
			expect(evaluatePermission(READ_ONLY_RULESET, definition.name)).not.toBe("ask")
		}
	})
})

/**
 * An unattended pass cannot obtain an approval, so a gated tool is not a safety feature to it: it
 * is nineteen extra schemas on every model call and, if the model tries one, a spent tool call plus
 * a `repeatedFailureLimit` slot. The follow-up conversation in the same session is the opposite
 * case, and that is where the gate is the whole point.
 */
describe("profileForTurn", () => {
	const agent: AgentDefinition = {
		name: "default",
		description: "",
		prompt: "",
		permission: DEFAULT_RULESET,
		budget: CHAT_BUDGET,
		model: "triage",
	}
	const rulesetFor = (kind: "app" | "autonomous") => profileForTurn(agent, { kind }).ruleset

	it("offers an autonomous pass no mutating tool at all", () => {
		for (const name of MUTATING_TOOL_NAMES) {
			expect(evaluatePermission(rulesetFor("autonomous"), name), name).toBe("deny")
		}
	})

	it("still gates rather than denies them for an attended turn", () => {
		for (const name of MUTATING_TOOL_NAMES) {
			expect(evaluatePermission(rulesetFor("app"), name), name).toBe("ask")
		}
	})

	it("keeps every read-only tool available to the pass", () => {
		for (const definition of mapleToolCatalog) {
			if (MUTATING_TOOL_NAMES.has(definition.name)) continue
			expect(evaluatePermission(rulesetFor("autonomous"), definition.name), definition.name).toBe(
				"allow",
			)
		}
	})
})
