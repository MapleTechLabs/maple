// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { describe, expect, it } from "@effect/vitest"
import { ChatApiGroup, CurrentTenant, V1SchemaErrors, V1UnexpectedErrors } from "@maple/domain/http"
import {
	ChatMessage,
	ChatToolCall,
	type ChatProposalOutcome,
	type ChatProposalSettlement,
} from "@maple/domain/chat-session"
import type { ChatSessionStub } from "@maple/domain/chat-session-stub"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpChatLive } from "./chat.http"
import { V1ErrorBoundaryLive } from "@maple/backend/http/error-boundary"

class ChatOnlyApi extends HttpApi.make("MapleAiApi")
	.add(ChatApiGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors) {}

const TENANT = new CurrentTenant.TenantSchema({
	orgId: "org_chat_approval" as CurrentTenant.TenantSchema["orgId"],
	userId: "user_chat_approval" as CurrentTenant.TenantSchema["userId"],
	roles: ["org:member" as CurrentTenant.TenantSchema["roles"][number]],
	authMode: "clerk",
})

const SESSION_ID = `${TENANT.orgId}:tab-1`

const AuthorizationStubLayer = Layer.succeed(
	CurrentTenant.SessionAuthorization,
	CurrentTenant.SessionAuthorization.of({
		bearer: (httpEffect) => Effect.provideService(httpEffect, CurrentTenant.Context, TENANT),
	}),
)

/** The transcript after the session recorded `result` as call_9's outcome. */
const recorded = (result: {
	readonly output: string
	readonly isError?: boolean
}): ReadonlyArray<ChatMessage> => [
	new ChatMessage({
		id: "a1",
		role: "assistant",
		text: "",
		createdAt: 0,
		startSeq: 1,
		toolCalls: [
			new ChatToolCall({
				id: "call_9",
				name: "delete_alert_rule",
				input: {},
				proposed: true,
				...result,
			}),
		],
	}),
]

const makeHarness = (session: {
	readonly settle?: () => Promise<ChatProposalOutcome>
	readonly history?: ReadonlyArray<ChatMessage>
}) => {
	const settlements: Array<ChatProposalSettlement> = []
	const stub: Pick<ChatSessionStub, "settleProposal" | "history"> = {
		settleProposal: (input) => {
			settlements.push(input)
			return session.settle?.() ?? Promise.resolve("decided")
		},
		history: () =>
			Promise.resolve(
				session.history ?? recorded({ output: "Approved in Maple.\nAlert rule deleted." }),
			),
	}
	const env = { ChatSession: { idFromName: (name: string) => name, get: () => stub } }

	const routes = HttpApiBuilder.layer(ChatOnlyApi).pipe(
		Layer.provide(HttpChatLive),
		Layer.provide(V1ErrorBoundaryLive),
		Layer.provideMerge(AuthorizationStubLayer),
		Layer.provideMerge(Layer.succeed(WorkerEnvironment, env as never)),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes as never, { disableLogger: true })

	const apply = async (body: Record<string, unknown>) => {
		const response = await handler(
			new Request("http://maple.test/internal/chat/apply", {
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return {
			status: response.status,
			body: text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>),
		}
	}

	return { apply, dispose, settlements }
}

const byReference = (decision: "approve" | "deny") => ({
	sessionId: SESSION_ID,
	toolCallId: "call_9",
	decision,
})

describe("POST /internal/chat/apply", () => {
	it("settles the proposal by reference, as the caller, and answers with what was recorded", async () => {
		const harness = makeHarness({})
		try {
			const response = await harness.apply(byReference("approve"))

			expect(response).toEqual({
				status: 200,
				body: { content: "Approved in Maple.\nAlert rule deleted." },
			})
			expect(harness.settlements).toEqual([
				{
					sessionId: SESSION_ID,
					toolCallId: "call_9",
					decision: "approve",
					approver: { kind: "app" },
					// The caller's own tenant and roles: the change runs as them, nothing granted here.
					tenant: {
						orgId: TENANT.orgId,
						userId: TENANT.userId,
						roles: ["org:member"],
						authMode: "clerk",
					},
				},
			])
		} finally {
			await harness.dispose()
		}
	})

	it("records a denial through the same path", async () => {
		const harness = makeHarness({
			history: recorded({ output: "Declined in Maple. The tool did not run.", isError: true }),
		})
		try {
			const response = await harness.apply(byReference("deny"))

			expect(response.body).toEqual({
				content: "Declined in Maple. The tool did not run.",
				isError: true,
			})
			expect(harness.settlements[0]?.decision).toBe("deny")
		} finally {
			await harness.dispose()
		}
	})

	it("ignores a by-value tool and input, and reads a missing decision as an approval", async () => {
		// What a tab loaded before this release sends. The tool it names is never what runs.
		const harness = makeHarness({})
		try {
			const response = await harness.apply({
				tool: "delete_dashboard",
				input: { dashboard_id: "d_1" },
				sessionId: SESSION_ID,
				messageId: "a1",
				toolCallId: "call_9",
			})

			expect(response.status).toBe(200)
			expect(harness.settlements).toHaveLength(1)
			expect(harness.settlements[0]).not.toHaveProperty("tool")
			expect(harness.settlements[0]).not.toHaveProperty("input")
			expect(harness.settlements[0]?.decision).toBe("approve")
		} finally {
			await harness.dispose()
		}
	})

	it("refuses a proposal somebody already decided", async () => {
		const harness = makeHarness({ settle: () => Promise.resolve("settled") })
		try {
			const response = await harness.apply(byReference("approve"))

			expect(response.status).toBe(400)
			expect(response.body?._tag).toBe("@maple/http/errors/ChatToolNotApplicableError")
		} finally {
			await harness.dispose()
		}
	})

	it("answers 404 for a call the conversation does not hold as a proposal", async () => {
		const harness = makeHarness({ settle: () => Promise.resolve("unknown") })
		try {
			const response = await harness.apply(byReference("approve"))

			expect(response.status).toBe(404)
			expect(response.body?._tag).toBe("@maple/http/errors/ChatToolNotFoundError")
		} finally {
			await harness.dispose()
		}
	})

	it("answers 404 for another org's conversation without reaching it", async () => {
		const harness = makeHarness({})
		try {
			const response = await harness.apply({ ...byReference("approve"), sessionId: "org_other:tab-1" })

			expect(response.status).toBe(404)
			expect(harness.settlements).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	it("serializes a session that could not be reached as a declared, hedged 500", async () => {
		const harness = makeHarness({ settle: () => Promise.reject(new Error("object evicted")) })
		try {
			const response = await harness.apply(byReference("approve"))

			expect(response.status).toBe(500)
			expect(response.body).toEqual({
				_tag: "@maple/http/errors/ChatToolExecutionError",
				toolCallId: "call_9",
				message: "Maple couldn't confirm the change — check the conversation.",
			})
		} finally {
			await harness.dispose()
		}
	})
})
