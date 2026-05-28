import { db } from "@electric-ax/agents-runtime"
import type { AgentTool, EntityRegistry, SharedStateHandle } from "@electric-ax/agents-runtime"
import { Type } from "@sinclair/typebox"
import { z } from "zod"
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
const PROVIDER = "openrouter" as const

const resolveApiKey = (provider: string): string | undefined =>
	provider === PROVIDER ? process.env.OPENROUTER_API_KEY : undefined

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
						content: async () => getConversationHistory(chatroom),
					},
				},
			})

			ctx.useAgent({
				systemPrompt,
				model: DEFAULT_MODEL,
				provider: PROVIDER,
				getApiKey: resolveApiKey,
				tools: [createSendMessageTool(chatroom.messages, ctx.entityUrl, name)],
			})
			await ctx.agent.run()
		},
	})
}

/** Read all messages from the shared state and format as conversation context. */
function getConversationHistory(chatroom: ChatroomState): string {
	const messages = (chatroom.messages as any).toArray as Array<{
		role: string
		senderName: string
		text: string
		timestamp: number
	}>
	if (messages.length === 0) return ""
	const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp)
	return (
		"\nConversation so far:\n" +
		sorted
			.map((m) => {
				const label = m.role === "user" ? `🧑 ${m.senderName} (human)` : m.senderName
				return `[${label}]: ${m.text}`
			})
			.join("\n") +
		"\n\nNote: Messages from humans are marked with 🧑. Pay attention to what the human says — their perspective matters. When you see a new human message, engage with it.\n"
	)
}

type MessageCollection = ChatroomState["messages"]

/** Wait for a shared state write to be persisted to the durable stream. */
async function awaitPersisted(transaction: unknown): Promise<void> {
	const promise = (transaction as { isPersisted?: { promise?: Promise<unknown> } } | null)?.isPersisted
		?.promise
	if (promise) await promise
}

function createSendMessageTool(
	messages: MessageCollection,
	entityUrl: string,
	displayName: string,
): AgentTool {
	return {
		name: "send_message",
		label: "Send Message",
		description: "Post a message to the chatroom.",
		parameters: Type.Object({
			text: Type.String({ description: "The message text to send" }),
		}),
		execute: async (_toolCallId, params) => {
			const { text } = params as { text: string }

			const transaction = (messages as any).insert({
				key: crypto.randomUUID(),
				role: "agent",
				sender: entityUrl,
				senderName: displayName,
				text,
				timestamp: Date.now(),
			})
			await awaitPersisted(transaction)

			return {
				content: [{ type: "text" as const, text: "Message sent." }],
				details: { text },
			}
		},
	}
}
