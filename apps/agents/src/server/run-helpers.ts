// Shared helpers for reading an entity's just-finished run off its own timeline and
// committing to shared state. Used by both the philosopher chat agent and the 1:1
// assistant agent.

export interface ChatMessage {
	role: string
	sender?: string
	senderName: string
	text: string
	timestamp: number
}

/** A compact record of a tool the agent called during a turn (persisted with the message). */
export interface ToolSummary {
	name: string
	status: string
}

/** Wait for a shared-state write to be persisted to the durable stream. */
export async function awaitPersisted(transaction: unknown): Promise<void> {
	const promise = (transaction as { isPersisted?: { promise?: Promise<unknown> } } | null)?.isPersisted
		?.promise
	if (promise) await promise
}

/** Snapshot the current set of run keys so we can isolate the run a later run() produces. */
export function snapshotRunKeys(entityDb: any): Set<string> {
	return new Set((entityDb.collections.runs.toArray as Array<{ key: string }>).map((r) => r.key))
}

function findNewRunKey(entityDb: any, priorRunKeys: Set<string>): string | undefined {
	const runs = entityDb.collections.runs.toArray as Array<{ key: string }>
	return runs.find((r) => !priorRunKeys.has(r.key))?.key
}

/**
 * Read the assistant prose produced by the most recent run. The `texts` rows carry no
 * content — the streamed characters live in `textDeltas` (one `delta` chunk per token-ish),
 * so we concatenate this run's deltas in stream order. `ctx.db` syncs from the durable
 * stream asynchronously, so we retry briefly until the new run's deltas appear.
 */
export async function readLatestRunText(entityDb: any, priorRunKeys: Set<string>): Promise<string> {
	for (let attempt = 0; attempt < 12; attempt++) {
		const newRunKey = findNewRunKey(entityDb, priorRunKeys)
		if (newRunKey) {
			const deltas = (
				entityDb.collections.textDeltas.toArray as Array<{
					run_id?: string
					delta: string
					_seq?: number
				}>
			)
				.filter((d) => d.run_id === newRunKey)
				.sort((a, b) => (a._seq ?? 0) - (b._seq ?? 0))
			if (deltas.length > 0) return deltas.map((d) => d.delta).join("").trim()
		}
		await new Promise((r) => setTimeout(r, 150))
	}
	return ""
}

/** Read the tool calls the most recent run made, as a compact summary for message history. */
export function readLatestRunToolCalls(entityDb: any, priorRunKeys: Set<string>): ToolSummary[] {
	const newRunKey = findNewRunKey(entityDb, priorRunKeys)
	if (!newRunKey) return []
	return (
		entityDb.collections.toolCalls.toArray as Array<{
			run_id?: string
			tool_name?: string
			status?: string
			_seq?: number
		}>
	)
		.filter((t) => t.run_id === newRunKey && t.tool_name)
		.sort((a, b) => (a._seq ?? 0) - (b._seq ?? 0))
		.map((t) => ({ name: t.tool_name as string, status: t.status ?? "completed" }))
}

/** Format the shared-state messages as plain-text conversation context for the LLM. */
export function formatConversationHistory(messages: ChatMessage[]): string {
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
