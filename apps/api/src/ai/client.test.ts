import { Context, Effect, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain/primitives"
import { describe, expect, it } from "vitest"
import { aiService, toolCallbacks } from "./client"
import type { TenantContext } from "@/services/auth/tenant-context"
import type { McpToolExecutorApi } from "@/mcp/dispatcher"
import { MUTATING_TOOL_NAMES } from "@/mcp/tools/mutating"

const tenant: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}
class Invocation extends Context.Reference<string>("test/Invocation", { defaultValue: () => "lost" }) {}
const result = { content: [{ type: "text" as const, text: "ok" }] }

describe("API capabilities supplied to AI", () => {
	it("fixes tenant and surface and preserves the caller's invocation context", async () => {
		const seen: unknown[] = []
		const executor: McpToolExecutorApi = {
			execute: (actualTenant, name, input, surface) =>
				Effect.gen(function* () {
					seen.push({ tenant: actualTenant, name, input, surface, invocation: yield* Invocation })
					return result
				}),
		}
		const callbacks = await Effect.runPromise(
			toolCallbacks(executor, tenant, "chat").pipe(Effect.provideService(Invocation, "original")),
		)
		await callbacks.execute("list_services", { orgId: "org_other" })
		expect(seen).toEqual([
			{
				tenant,
				name: "list_services",
				input: { orgId: "org_other" },
				surface: "chat",
				invocation: "original",
			},
		])
	})

	it("refuses every mutating tool even if the AI service asks for it directly", async () => {
		let executions = 0
		const callbacks = await Effect.runPromise(
			toolCallbacks(
				{
					execute: () =>
						Effect.sync(() => {
							executions++
							return result
						}),
				},
				tenant,
				"workflow",
			),
		)
		for (const name of MUTATING_TOOL_NAMES) expect((await callbacks.execute(name, {})).isError).toBe(true)
		expect(executions).toBe(0)
	})

	it("revokes tool execution when the chat turn is released", async () => {
		let active = true
		let executions = 0
		const callbacks = await Effect.runPromise(
			toolCallbacks(
				{
					execute: () =>
						Effect.sync(() => {
							executions++
							return result
						}),
				},
				tenant,
				"chat",
				() => active,
			),
		)
		await callbacks.execute("list_services", {})
		active = false
		await expect(callbacks.execute("list_services", {})).rejects.toMatchObject({
			_tag: "@maple/ai/ServiceError",
		})
		expect(executions).toBe(1)
	})
})

describe("AI binding failures", () => {
	const input = {
		orgId: "org_test",
		investigationId: "11111111-1111-4111-8111-111111111111",
		subject: null,
		snapshot: null,
		deadlineAtMs: 0,
	}
	it("fails explicitly when the binding is missing", async () => {
		await expect(
			Effect.runPromise(aiService({}).plan(input, [], { execute: async () => result })),
		).rejects.toMatchObject({
			_tag: "@maple/ai/ServiceError",
			message: "AI service binding is unavailable",
		})
	})
	it("maps transport failures without exposing their internals", async () => {
		const client = aiService({
			MAPLE_AI: {
				plan: async () => {
					throw new Error("private transport details")
				},
			},
		})
		await expect(
			Effect.runPromise(client.plan(input, [], { execute: async () => result })),
		).rejects.toMatchObject({ _tag: "@maple/ai/ServiceError", message: "AI plan failed" })
	})
})
