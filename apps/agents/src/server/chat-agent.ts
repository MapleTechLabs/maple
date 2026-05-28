import { db } from "@electric-ax/agents-runtime"
import type { EntityRegistry, SharedStateHandle } from "@electric-ax/agents-runtime"
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

/** Sentinel an agent emits to stay silent (since there's no tool to "not call"). */
const SILENCE = "PASS"

// Appended to every persona prompt: the agent replies as plain prose (which streams
// token-by-token to its timeline), and uses PASS to opt out of a turn.
const REPLY_INSTRUCTIONS = `

Write your reply directly as your message — just the text you want to say, nothing else. Do not mention tools or narrate your actions. If you have nothing worth adding this turn, reply with exactly: ${SILENCE}`

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

			// No tools: the agent replies as assistant prose, which streams to its own
			// timeline (text_delta rows) — that's what the UI renders live. We capture
			// the finished text below and commit it to shared state for coordination.
			ctx.useAgent({
				systemPrompt: systemPrompt + REPLY_INSTRUCTIONS,
				model: DEFAULT_MODEL,
				provider: PROVIDER,
				getApiKey: resolveApiKey,
				tools: [],
			})

			// Record existing runs so we can isolate the one this run() produces.
			const priorRunKeys = new Set(
				((ctx.db.collections.runs as any).toArray as Array<{ key: string }>).map((r) => r.key),
			)

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

/**
 * Read the assistant prose produced by the most recent run. The `texts` collection
 * rows carry no content — the streamed characters live in `textDeltas` (one `delta`
 * chunk per token-ish), so we concatenate this run's deltas in stream order.
 */
async function readLatestRunText(entityDb: any, priorRunKeys: Set<string>): Promise<string> {
	// ctx.db's collections sync from the durable stream asynchronously, so the just-
	// finished run's deltas may not be present the instant run() resolves. Retry briefly.
	for (let attempt = 0; attempt < 12; attempt++) {
		const runs = entityDb.collections.runs.toArray as Array<{ key: string }>
		const newRun = runs.find((r) => !priorRunKeys.has(r.key))
		if (newRun) {
			const deltas = (
				entityDb.collections.textDeltas.toArray as Array<{
					run_id?: string
					delta: string
					_seq?: number
				}>
			)
				.filter((d) => d.run_id === newRun.key)
				.sort((a, b) => (a._seq ?? 0) - (b._seq ?? 0))
			if (deltas.length > 0) return deltas.map((d) => d.delta).join("").trim()
		}
		await new Promise((r) => setTimeout(r, 150))
	}
	return ""
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

/** Wait for a shared state write to be persisted to the durable stream. */
async function awaitPersisted(transaction: unknown): Promise<void> {
	const promise = (transaction as { isPersisted?: { promise?: Promise<unknown> } } | null)?.isPersisted
		?.promise
	if (promise) await promise
}
