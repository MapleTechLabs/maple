import { db } from "@electric-ax/agents-runtime"
import type { EntityRegistry, SharedStateHandle } from "@electric-ax/agents-runtime"
import { z } from "zod"
import {
	awaitPersisted,
	formatConversationHistory,
	readLatestRunText,
	snapshotRunKeys,
} from "./run-helpers.js"
import { chatroomSchema } from "./schema.js"

export type ChatroomState = SharedStateHandle<typeof chatroomSchema>

/**
 * Model + provider for the agents. We route through OpenRouter (the same provider
 * Maple uses for its chat agent) rather than Anthropic directly.
 *
 * `moonshotai/kimi-k2.5` is a key in pi-ai's openrouter model registry. (Maple's
 * own gateway uses the `:nitro` routing variant — that suffix is NOT a registry
 * key, so forcing it would require passing a full custom `Model` object instead of
 * a string id. For this minimal version the base model id is sufficient.)
 */
export const DEFAULT_MODEL = "moonshotai/kimi-k2.5"
export const PROVIDER = "openrouter" as const

export const resolveOpenRouterKey = (provider: string): string | undefined =>
	provider === PROVIDER ? process.env.OPENROUTER_API_KEY : undefined

/** Sentinel an agent emits to stay silent (since there's no tool to "not call"). */
const SILENCE = "PASS"

// Appended to every persona prompt: the agent replies as plain prose (which streams
// token-by-token to its timeline), and uses PASS to opt out of a turn.
const REPLY_INSTRUCTIONS = `

Write your reply directly as your message — just the text you want to say, nothing else. Do not mention tools or narrate your actions. If you have nothing worth adding this turn, reply with exactly: ${SILENCE}`

const chatAgentArgs = z.object({ chatroomId: z.string().min(1) })

/** Register a chat agent that observes a shared chatroom and responds to messages. */
export function registerChatAgent(
	registry: EntityRegistry,
	name: string,
	description: string,
	systemPrompt: string,
): void {
	registry.define(name, {
		description,
		creationSchema: chatAgentArgs,

		async handler(ctx) {
			const args = chatAgentArgs.parse(ctx.args)

			if (ctx.firstWake) {
				ctx.mkdb(args.chatroomId, chatroomSchema)
			}

			const chatroom = (await ctx.observe(db(args.chatroomId, chatroomSchema), {
				wake: { on: "change", collections: ["shared:message"] },
			})) as unknown as ChatroomState

			if (ctx.firstWake) return

			// Decide whether to respond: new user message OR mentioned by name.
			const allMessages = (chatroom.messages as any).toArray as Array<{
				role: string
				sender: string
				text: string
				timestamp: number
			}>
			const sorted = [...allMessages].sort((a, b) => a.timestamp - b.timestamp)

			// Find this agent's last reply.
			let lastReplyIdx = -1
			for (let i = sorted.length - 1; i >= 0; i--) {
				if (sorted[i]!.sender === ctx.entityUrl) {
					lastReplyIdx = i
					break
				}
			}

			// Messages since this agent last replied.
			const newMessages = sorted.slice(lastReplyIdx + 1)
			if (newMessages.length === 0) return

			// Respond if a human sent a message, OR someone mentioned this agent by name.
			const hasNewUserMessage = newMessages.some((m) => m.role === "user")
			const mentionedByName = newMessages.some(
				(m) => m.sender !== ctx.entityUrl && m.text.toLowerCase().includes(name.toLowerCase()),
			)
			if (!hasNewUserMessage && !mentionedByName) return

			ctx.useContext({
				sourceBudget: 50_000,
				sources: {
					conversation: {
						cache: "volatile",
						content: async () => formatConversationHistory((chatroom.messages as any).toArray),
					},
				},
			})

			// No tools: the agent replies as assistant prose, which streams to its own
			// timeline (text_delta rows) — that's what the UI renders live. We capture
			// the finished text below and commit it to shared state for coordination.
			ctx.useAgent({
				systemPrompt: systemPrompt + REPLY_INSTRUCTIONS,
				model: DEFAULT_MODEL,
				provider: PROVIDER,
				getApiKey: resolveOpenRouterKey,
				tools: [],
			})

			// Record existing runs so we can isolate the one this run() produces.
			const priorRunKeys = snapshotRunKeys(ctx.db)

			await ctx.agent.run()

			// Models sometimes append the sentinel to a real reply ("… again. PASS")
			// or return it alone — strip a trailing PASS and treat empties as silence.
			const reply = (await readLatestRunText(ctx.db, priorRunKeys))
				.replace(/\s*\bPASS\b\.?\s*$/i, "")
				.trim()
			if (reply.length > 0 && reply.toUpperCase() !== SILENCE) {
				const tx = (chatroom.messages as any).insert({
					key: crypto.randomUUID(),
					role: "agent",
					sender: ctx.entityUrl,
					senderName: name,
					text: reply,
					timestamp: Date.now(),
				})
				await awaitPersisted(tx)
			}
		},
	})
}



