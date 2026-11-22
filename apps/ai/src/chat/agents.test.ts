/**
 * The agent registry's invariants: a mode with no agent is a runtime `undefined` in the middle of
 * a turn, which is cheap to assert here and expensive to debug live.
 */
import {
	type ChatConnectorOrigin,
	type ChatTurnOrigin,
	ChatConnectorId,
	ChatConversationKey,
	ChatMode,
	connectorSessionId,
	makeChatSessionId,
} from "@maple/domain/chat-session"
import { evaluatePermission } from "@maple/domain/permission"
import * as Policy from "@maple/domain/policy"
import { ExternalUserId, OrgId, RoleName, UserId } from "@maple/primitives"
import { Effect, Schema, Array as Arr, String as Str } from "effect"
import { assert, describe, it } from "vitest"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { noRepositoryWarmup } from "../../test/chat/tool-executor"
import { mapleToolCatalog, mapleToolCatalogFor } from "../mcp/tools/registry"
import { DASHBOARD_AUTHORING_TOOLS } from "./approval-permission"
import { MUTATING_TOOL_NAMES } from "./permissions"
import type { TenantContext } from "@maple/domain/http"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { AGENTS, agentForSession, isAutonomousTurn, sessionOf } from "./agents"
import { profileForTenant, profileForTurn, toolSurfaceForApproval } from "./profiles"
import { CONNECTOR_SYSTEM_PROMPT } from "./prompts"
import { buildChatToolkit } from "./maple-toolkit"

/** A connector id, not a real one: the engine never learns which chat platform it answers in. */
const CONNECTOR = Schema.decodeSync(ChatConnectorId)("testchat")
const CONVERSATION = Schema.decodeSync(ChatConversationKey)("c1")

/** Someone the host could not resolve to a Maple user: a connector with no account linking. */
const ANONYMOUS_ORIGIN: ChatConnectorOrigin = {
	kind: "connector",
	connectorId: CONNECTOR,
	workspaceId: "w1",
	externalUserId: Schema.decodeSync(ExternalUserId)("u-1"),
	displayName: "Ada",
}

/** The same asker on a connector that links accounts, resolved to their Maple user. */
const CONNECTOR_ORIGIN: ChatTurnOrigin = {
	...ANONYMOUS_ORIGIN,
	actingUserId: Schema.decodeSync(UserId)("user_ada"),
}

/** Reads a turn nobody is named on is not offered: connected systems, source, SQL, end users. */
const WITHHELD_FROM_ANONYMOUS = [
	"query_data_source",
	"list_data_sources",
	"run_sql",
	"list_users",
	"inspect_user",
	"search_sessions",
	"get_session_transcript",
	"get_agent_session_transcript",
	"list_integrations",
	"list_source_repositories",
	"search_source_code",
	"read_source_file",
]

describe("AGENTS", () => {
	it("names an agent for every wire mode", () => {
		// `AGENTS` is keyed by `ChatMode`, so the compiler covers the keys; this pins that the record's
		// key IS the agent's name, which `agentForSession` relies on.
		for (const mode of ChatMode.literals) {
			assert.equal(AGENTS[mode].name, mode)
		}
	})
})

describe("sessionOf", () => {
	const UUID = "7f1d3c2e-9a4b-4c8d-8e2f-1a2b3c4d5e6f"

	it("names the row a session's turns settle, by mode", () => {
		assert.deepEqual(sessionOf(makeChatSessionId("org_1", `inv-${UUID}`)).row, {
			kind: "investigate",
			id: UUID,
		})
		assert.deepEqual(sessionOf(makeChatSessionId("org_1", `pr-${UUID}`)).row, {
			kind: "pr-review",
			id: UUID,
		})
		assert.deepEqual(sessionOf(makeChatSessionId("org_1", `prr-${UUID}`)).row, {
			kind: "pr-reply",
			id: UUID,
		})
		assert.isUndefined(sessionOf(makeChatSessionId("org_1", "tab")).row)
	})

	/**
	 * Documents today's split: the prefix alone picks the persona, budget and code mode, but only
	 * an id that decodes makes it a row. So an `inv-<non-uuid>` session runs the investigate agent
	 * as an ordinary conversation: no `submit_diagnosis`, no close-out, billed as plain chat.
	 */
	it("keeps the mode's agent for a prefix whose id does not decode, with no row", () => {
		const session = sessionOf(makeChatSessionId("org_1", "inv-not-a-uuid"))
		assert.equal(session.agent.name, "investigate")
		assert.isUndefined(session.row)
		assert.isFalse(isAutonomousTurn(session.row, { kind: "autonomous" }))
	})

	it("treats only an unattended turn on a row as a pass the runner closes out", () => {
		const { row } = sessionOf(makeChatSessionId("org_1", `inv-${UUID}`))
		assert.isTrue(isAutonomousTurn(row, { kind: "autonomous" }))
		assert.isFalse(isAutonomousTurn(row, { kind: "app" }))
		assert.isFalse(isAutonomousTurn(row, CONNECTOR_ORIGIN))
	})
})

describe("agentForSession", () => {
	it("maps a session id to its mode's agent", () => {
		assert.equal(agentForSession(makeChatSessionId("org_1", "tab")).name, "default")
		assert.equal(agentForSession(makeChatSessionId("org_1", "pr-123")).name, "pr-review")
		assert.equal(agentForSession(makeChatSessionId("org_1", "inv-abc")).name, "investigate")
		// A connector thread is an ordinary chat conversation; its ORIGIN is what differs.
		assert.equal(
			agentForSession(connectorSessionId(Schema.decodeSync(OrgId)("org_1"), CONNECTOR, CONVERSATION))
				.name,
			"default",
		)
	})
})

/**
 * What a turn's origin decides, through the toolkit a run actually builds. A connector proposes
 * mutations exactly as the app does, but runs on a surface that is not internal — so the
 * agents-only tools never enter its catalog. Both directions, so neither can pass vacuously.
 */
describe("profileForTurn", () => {
	const orgId = Schema.decodeSync(OrgId)("org_test")
	const connectorSession = connectorSessionId(orgId, CONNECTOR, CONVERSATION)
	const appSession = makeChatSessionId(orgId, "tab")
	const tenant: TenantContext = {
		orgId,
		userId: Schema.decodeSync(UserId)("user_1"),
		roles: [],
		permissions: Policy.grantsOf([]),
		authMode: "self_hosted",
	}
	const executor: McpToolExecutorApi = {
		...noRepositoryWarmup,
		execute: (_tenant, name) => Effect.succeed({ content: [{ type: "text" as const, text: name }] }),
	}
	/** Exactly what `runChatTurn` builds, through the same policy. */
	const toolsFor = (sessionId: string, origin: ChatTurnOrigin) => {
		const profile = profileForTurn(agentForSession(sessionId), origin)
		return {
			profile,
			tools: buildChatToolkit(executor, tenant, profile.ruleset, profile.toolSurface, "record").toolkit
				.tools,
		}
	}

	it("offers a connector every mutating tool, and proposes rather than performs each one", () => {
		// `ask` is the whole of a proposal: `run.ts`'s `isProposed` reads it, the dispatched call
		// refuses, and the schema the connector renders for approval is the real one.
		const { profile, tools } = toolsFor(connectorSession, CONNECTOR_ORIGIN)
		for (const name of MUTATING_TOOL_NAMES) {
			assert.property(tools, name, `${name} was withheld from the connector`)
			assert.equal(evaluatePermission(profile.ruleset, name), "ask", name)
		}
	})

	const appProfileFor = (permissions: Policy.Grants) =>
		profileForTenant(profileForTurn(agentForSession(appSession), { kind: "app" }), { permissions })

	it("proposes dashboard changes to an analyst and offers no other tool that changes data", () => {
		const profile = appProfileFor(Policy.grantsOf(["org:analyst"]))
		const { tools } = buildChatToolkit(
			executor,
			tenant,
			profile.ruleset,
			profile.toolSurface,
			"record",
		).toolkit
		assert.property(tools, "search_traces")
		for (const name of MUTATING_TOOL_NAMES) {
			if (DASHBOARD_AUTHORING_TOOLS.has(name)) {
				assert.equal(evaluatePermission(profile.ruleset, name), "ask", name)
			} else {
				assert.notProperty(tools, name, `${name} was offered to an analyst`)
			}
		}
		assert.property(tools, "create_dashboard")
		// A member's turn on the same session still proposes every one of them.
		const member = appProfileFor(Policy.grantsOf(["org:member"]))
		for (const name of MUTATING_TOOL_NAMES) {
			assert.equal(evaluatePermission(member.ruleset, name), "ask", name)
		}
	})

	it("offers a custom role that only reads telemetry the read tools and no change at all", () => {
		const profile = appProfileFor(["telemetry:read", "ai:ask"])
		assert.equal(evaluatePermission(profile.ruleset, "search_traces"), "allow")
		for (const name of MUTATING_TOOL_NAMES) {
			assert.equal(evaluatePermission(profile.ruleset, name), "deny", name)
		}
		// Reads it does not hold are not offered either: raw SQL and the Security Center.
		assert.equal(evaluatePermission(profile.ruleset, "run_sql"), "deny")
		assert.equal(evaluatePermission(profile.ruleset, "list_security_findings"), "deny")
	})

	it("proposes no dashboard change to a custom role that acts through Maple AI but may not edit dashboards", () => {
		const profile = appProfileFor(["telemetry:read", "ai:ask", "ai:act", "alerts:manage"])
		for (const name of MUTATING_TOOL_NAMES) {
			assert.equal(
				evaluatePermission(profile.ruleset, name),
				DASHBOARD_AUTHORING_TOOLS.has(name) ? "deny" : "ask",
				name,
			)
		}
	})

	it("offers query_data_source only to a turn whose query the service would run", () => {
		const offered = (caller: Pick<TenantContext, "roles" | "turnOrigin" | "turnStarter">) => {
			const origin = caller.turnOrigin ?? { kind: "app" }
			const session = origin.kind === "connector" ? connectorSession : appSession
			const profile = profileForTenant(profileForTurn(agentForSession(session), origin), {
				...caller,
				permissions: Policy.grantsOf(caller.roles),
			})
			return evaluatePermission(profile.ruleset, "query_data_source") !== "deny"
		}
		const roles = (name: string) => [Schema.decodeSync(RoleName)(name)]
		const autonomous = { kind: "autonomous" } as const
		assert.deepStrictEqual(
			{
				analyst: offered({ roles: roles("org:analyst") }),
				member: offered({ roles: roles("org:member") }),
				engineer: offered({ roles: roles("org:engineer") }),
				unlinkedConnector: offered({ roles: [], turnOrigin: CONNECTOR_ORIGIN }),
				producerPass: offered({
					roles: [],
					turnOrigin: autonomous,
					turnStarter: { kind: "producer" },
				}),
				memberStartedPass: offered({
					roles: [],
					turnOrigin: autonomous,
					turnStarter: { kind: "person", roles: roles("org:member") },
				}),
				engineerStartedPass: offered({
					roles: [],
					turnOrigin: autonomous,
					turnStarter: { kind: "person", roles: roles("org:engineer") },
				}),
				passNobodyStarted: offered({ roles: [], turnOrigin: autonomous }),
			},
			{
				analyst: false,
				member: false,
				engineer: true,
				unlinkedConnector: false,
				producerPass: true,
				memberStartedPass: false,
				engineerStartedPass: true,
				passNobodyStarted: false,
			},
		)
	})

	it("offers a connector the repository sandbox but no internal-audience tool", () => {
		// The reviewer's pull request tools act on the org's behalf; a channel never reaches them.
		const { tools } = toolsFor(connectorSession, CONNECTOR_ORIGIN)
		const internal = Arr.filter(mapleToolCatalog, (definition) => definition.audience === "internal")
		assert.isNotEmpty(internal, "no internal tools in the catalog — this test would pass vacuously")
		for (const definition of internal) {
			assert.notProperty(tools, definition.name, `${definition.name} was offered to the connector`)
		}
		for (const name of ["sandbox_grep", "sandbox_list_files", "sandbox_read_file", "sandbox_exec"]) {
			assert.property(tools, name, `${name} was withheld from the connector`)
		}
	})

	it("keeps the read tools a connector answers with, ungated", () => {
		const { profile, tools } = toolsFor(connectorSession, CONNECTOR_ORIGIN)
		for (const name of ["find_errors", "search_traces", "list_services", "query_data"]) {
			assert.property(tools, name)
			assert.equal(evaluatePermission(profile.ruleset, name), "allow", name)
		}
	})

	it("leaves an app turn its own persona, surface and internal tools", () => {
		const { profile, tools } = toolsFor(appSession, { kind: "app" })
		assert.equal(profile.surface, "chat")
		assert.equal(profile.prompt, AGENTS.default.prompt)
		assert.property(tools, "sandbox_exec")
	})

	it("speaks the connector persona, not the in-app one that teaches a 420px panel", () => {
		assert.equal(
			profileForTurn(agentForSession(connectorSession), CONNECTOR_ORIGIN).prompt,
			CONNECTOR_SYSTEM_PROMPT,
		)
	})

	it("offers a connector turn nobody is named on no tool that changes data", () => {
		const { profile, tools } = toolsFor(connectorSession, ANONYMOUS_ORIGIN)
		assert.isNotEmpty([...MUTATING_TOOL_NAMES])
		for (const name of MUTATING_TOOL_NAMES) {
			assert.notProperty(tools, name, `${name} was offered to a turn nobody is named on`)
			// Never `ask`: a proposal here would post an approval card nobody can honour.
			assert.equal(evaluatePermission(profile.ruleset, name), "deny", name)
		}
	})

	it("offers that turn no data source, SQL, end-user or source tool, and no sandbox", () => {
		const { tools } = toolsFor(connectorSession, ANONYMOUS_ORIGIN)
		const sandbox = Arr.filter(mapleToolCatalog, (tool) => Str.startsWith("sandbox_")(tool.name))
		for (const name of [...WITHHELD_FROM_ANONYMOUS, ...Arr.map(sandbox, (tool) => tool.name)]) {
			assert.notProperty(tools, name, `${name} was offered to a turn nobody is named on`)
		}
		// The linked asker on the same conversation is still offered every one of them.
		const linked = toolsFor(connectorSession, CONNECTOR_ORIGIN).tools
		for (const name of WITHHELD_FROM_ANONYMOUS) assert.property(linked, name)
	})

	it("still answers that turn from telemetry, ungated", () => {
		const { profile, tools } = toolsFor(connectorSession, ANONYMOUS_ORIGIN)
		for (const name of ["find_errors", "search_traces", "list_services", "query_data"]) {
			assert.property(tools, name)
			assert.equal(evaluatePermission(profile.ruleset, name), "allow", name)
		}
	})

	it("applies an approved change on a surface that admits it only for a named approver", () => {
		const agent = agentForSession(connectorSession)
		const admitsChanges = (surface: McpToolSurface) =>
			Arr.some(mapleToolCatalogFor(surface), (tool) => MUTATING_TOOL_NAMES.has(tool.name))
		const approver = ANONYMOUS_ORIGIN

		assert.isTrue(
			admitsChanges(toolSurfaceForApproval(agent, { approver, actingUserId: "user_ada" })),
			"a linked approver's change was not admitted",
		)
		assert.isTrue(
			admitsChanges(toolSurfaceForApproval(agentForSession(appSession), { approver: { kind: "app" } })),
		)
		// Whatever let it through this far, the registry holds nothing for it to run.
		assert.isFalse(admitsChanges(toolSurfaceForApproval(agent, { approver })))
	})

	it("denies the autonomous pass its mutations while leaving it the internal tools", () => {
		// Unchanged: the pass has no reader, so a gated tool is a wasted call.
		const { profile, tools } = toolsFor(makeChatSessionId(orgId, "inv-abc"), { kind: "autonomous" })
		assert.equal(profile.surface, "chat")
		assert.property(tools, "sandbox_exec")
		for (const name of MUTATING_TOOL_NAMES) assert.notProperty(tools, name)
	})
})
