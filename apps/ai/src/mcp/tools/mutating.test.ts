import { describe, expect, it } from "vitest"
import { mapleToolCatalog } from "./registry"
import { MUTATING_TOOL_NAMES } from "./mutating"
import { evaluatePermission, isToolVisible } from "@maple/domain/permission"
import { DEFAULT_RULESET, READ_ONLY_RULESET } from "../../chat/permissions"
import { profileForTurn } from "../../chat/profiles"
import { CHAT_BUDGET } from "../../chat/budgets"

const CONNECTOR_ORIGIN = {
	kind: "connector",
	connectorId: "testchat",
	workspaceId: "w1",
	externalUserId: "u-1",
	displayName: "Ada",
} as const

describe("MUTATING_TOOL_NAMES", () => {
	it("every approval-gated tool exists in the registry", () => {
		const registered = new Set(mapleToolCatalog.map((d) => d.name))
		for (const name of MUTATING_TOOL_NAMES) {
			expect(registered.has(name), `missing registered tool: ${name}`).toBe(true)
		}
	})

	it("excludes read-only tools (so /chat/apply can't run them)", () => {
		expect(MUTATING_TOOL_NAMES.has("find_errors")).toBe(false)
		expect(MUTATING_TOOL_NAMES.has("search_traces")).toBe(false)
		expect(MUTATING_TOOL_NAMES.has("list_dashboards")).toBe(false)
		expect(MUTATING_TOOL_NAMES.has("get_dashboard")).toBe(false)
	})

	it("covers the dashboard/alert/issue mutations", () => {
		expect(MUTATING_TOOL_NAMES.has("update_dashboard_widget")).toBe(true)
		expect(MUTATING_TOOL_NAMES.has("create_alert_rule")).toBe(true)
		expect(MUTATING_TOOL_NAMES.has("transition_error_issue")).toBe(true)
	})
})

describe("DEFAULT_RULESET", () => {
	it("is exactly MUTATING_TOOL_NAMES, expressed as rules", () => {
		// The migration lock. Rulesets replaced a flat `Set`, and the whole claim of that change is
		// that day-one behaviour is unchanged: every registered tool resolves to `ask` if and only
		// if it is in the set, and to `allow` otherwise. If either side drifts, this fails loudly
		// rather than quietly widening what the chat agent can do without approval.
		for (const definition of mapleToolCatalog) {
			expect(
				evaluatePermission(DEFAULT_RULESET, definition.name),
				`permission drifted for ${definition.name}`,
			).toBe(MUTATING_TOOL_NAMES.has(definition.name) ? "ask" : "allow")
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
	const agent = {
		name: "default",
		description: "",
		prompt: "",
		permission: DEFAULT_RULESET,
		budget: CHAT_BUDGET,
	}
	const rulesetFor = (kind: "app" | "autonomous" | "connector") =>
		profileForTurn(agent, kind === "connector" ? CONNECTOR_ORIGIN : { kind }).ruleset

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

	it("gates rather than denies for a connector turn, which proposes into the thread", () => {
		for (const name of MUTATING_TOOL_NAMES) {
			expect(evaluatePermission(rulesetFor("connector"), name), name).toBe("ask")
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
