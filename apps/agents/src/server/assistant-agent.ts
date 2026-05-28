import type { AgentTool, EntityRegistry, SharedStateHandle } from "@electric-ax/agents-runtime"
import { db } from "@electric-ax/agents-runtime"
import { Type } from "@sinclair/typebox"
import { z } from "zod"
import { DEFAULT_MODEL, PROVIDER, resolveOpenRouterKey } from "./chat-agent.js"
import { callMapleMcp } from "./maple-mcp.js"
import {
	awaitPersisted,
	formatConversationHistory,
	readLatestRunText,
	readLatestRunToolCalls,
	snapshotRunKeys,
} from "./run-helpers.js"
import { chatroomSchema } from "./schema.js"

type ChatroomState = SharedStateHandle<typeof chatroomSchema>

export const ASSISTANT_TYPE = "assistant"
const ASSISTANT_NAME = "Maple"

const SYSTEM_PROMPT = `You are Maple's observability assistant — a concise, friendly engineer who helps users understand their telemetry (services, errors, traces, logs).

You have read-only tools to inspect the user's live data:
- list_services: list active services with throughput, error rate, and P95 latency.
- find_errors: find and categorize recent errors by type, with counts and affected services.

Use a tool whenever the user asks about what's happening in their system right now (e.g. "what services are running", "any errors lately"). Call tools with no arguments to use sensible defaults (recent time window). After getting results, answer in clear, short markdown — lead with the answer, use a compact table or bullet list when it helps. If a tool fails or returns nothing, say so plainly. Never invent service names or numbers.`

const assistantArgs = z.object({
	chatroomId: z.string().min(1),
	orgId: z.string().optional(),
})

const optionalStr = (description: string) => Type.Optional(Type.String({ description }))

function mapleTools(orgId: string): AgentTool[] {
	const runTool = async (name: string, params: Record<string, unknown>) => {
		try {
			const text = await callMapleMcp(orgId, name, params)
			return { content: [{ type: "text" as const, text }], details: { params } }
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: { error: message } }
		}
	}

	return [
		{
			name: "list_services",
			label: "List services",
			description:
				"List active services with key metrics (throughput, error rate, P95 latency). Call with no args for the recent window.",
			parameters: Type.Object({
				start_time: optionalStr("Start of range, YYYY-MM-DD HH:mm:ss UTC"),
				end_time: optionalStr("End of range, YYYY-MM-DD HH:mm:ss UTC"),
				environment: optionalStr("Filter by deployment environment"),
			}),
			execute: async (_id, params) => runTool("list_services", params as Record<string, unknown>),
		},
		{
			name: "find_errors",
			label: "Find errors",
			description: "Find and categorize recent errors by type, with counts and affected services.",
			parameters: Type.Object({
				start_time: optionalStr("Start of range, YYYY-MM-DD HH:mm:ss"),
				end_time: optionalStr("End of range, YYYY-MM-DD HH:mm:ss"),
				service: optionalStr("Filter to a specific service"),
				environment: optionalStr("Filter by deployment environment"),
				limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
			}),
			execute: async (_id, params) => runTool("find_errors", params as Record<string, unknown>),
		},
	]
}

/**
 * Register a single 1:1 "assistant" agent: replies to every new user message, streams
 * prose, and can call read-only Maple tools. Mirrors the philosopher chat machinery but
 * without the selective/PASS logic.
 */
export function registerAssistantAgent(registry: EntityRegistry): void {
	registry.define(ASSISTANT_TYPE, {
		description: "Maple observability assistant (Electric-backed)",
		creationSchema: assistantArgs,

		async handler(ctx) {
			const args = assistantArgs.parse(ctx.args)

			if (ctx.firstWake) {
				ctx.mkdb(args.chatroomId, chatroomSchema)
			}

			const chatroom = (await ctx.observe(db(args.chatroomId, chatroomSchema), {
				wake: { on: "change", collections: ["shared:message"] },
			})) as unknown as ChatroomState

			if (ctx.firstWake) return

			const allMessages = (chatroom.messages as any).toArray as Array<{
				role: string
				sender?: string
				senderName: string
				text: string
				timestamp: number
			}>
			const sorted = [...allMessages].sort((a, b) => a.timestamp - b.timestamp)

			// Respond whenever there's a new user message since our last reply (1:1).
			let lastReplyIdx = -1
			for (let i = sorted.length - 1; i >= 0; i--) {
				if (sorted[i]!.sender === ctx.entityUrl) {
					lastReplyIdx = i
					break
				}
			}
			const since = sorted.slice(lastReplyIdx + 1)
			if (!since.some((m) => m.role === "user")) return

			ctx.useContext({
				sourceBudget: 50_000,
				sources: {
					conversation: {
						cache: "volatile",
						content: async () => formatConversationHistory(sorted),
					},
				},
			})

			const orgId = args.orgId ?? "default"
			ctx.useAgent({
				systemPrompt: SYSTEM_PROMPT,
				model: DEFAULT_MODEL,
				provider: PROVIDER,
				getApiKey: resolveOpenRouterKey,
				tools: mapleTools(orgId),
			})

			const priorRunKeys = snapshotRunKeys(ctx.db)
			await ctx.agent.run()

			const reply = await readLatestRunText(ctx.db, priorRunKeys)
			const tools = readLatestRunToolCalls(ctx.db, priorRunKeys)
			if (reply.length > 0) {
				const tx = (chatroom.messages as any).insert({
					key: crypto.randomUUID(),
					role: "agent",
					sender: ctx.entityUrl,
					senderName: ASSISTANT_NAME,
					text: reply,
					timestamp: Date.now(),
					...(tools.length > 0 ? { tools } : {}),
				})
				await awaitPersisted(tx)
			}
		},
	})
}
