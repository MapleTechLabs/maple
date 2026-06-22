import type { UIMessage } from "@flue/react"

/**
 * Client-owned record of the user's sent messages for a Flue conversation.
 *
 * Why this exists: the deployed `@flue/runtime` persists the user prompt to the
 * agent's server-side context and then drives the model via `agentLoop.continue()`,
 * which (unlike the fresh-prompt path) never emits a `message_start`/`message_end`
 * for the user message. So the durable event stream `@flue/react` consumes carries
 * only assistant turns + tools — the user's own message is never in it (live or on
 * replay). `@flue/react` shows an optimistic user bubble on send but deletes it the
 * moment the assistant turn begins, expecting a durable echo that never arrives —
 * hence "user message flashes then vanishes".
 *
 * We compensate by owning the user's messages ourselves (mirroring how the mobile
 * app stayed local-first), persisting them per conversation and merging them back
 * into the rendered transcript. See {@link mergeUserMessages}.
 */
export interface UserLogEntry {
	/** Stable synthetic id, unique within a conversation. */
	id: string
	/** The user's text with any context preamble already stripped (display-ready). */
	text: string
	/**
	 * Number of assistant messages present in the Flue transcript when this message
	 * was sent. Used as a stable anchor to interleave the user message before the
	 * assistant turn(s) it triggered — stable because Flue replays the same assistant
	 * turns in the same order on reload.
	 */
	turnsBefore: number
}

const STORAGE_PREFIX = "maple:flue-chat:user-log:"

const isUserLogEntry = (value: unknown): value is UserLogEntry =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as UserLogEntry).id === "string" &&
	typeof (value as UserLogEntry).text === "string" &&
	typeof (value as UserLogEntry).turnsBefore === "number"

export const userLogStorageKey = (conversationId: string): string => `${STORAGE_PREFIX}${conversationId}`

/** Load the persisted user log for a conversation (SSR/quota-safe, never throws). */
export function loadUserLog(conversationId: string | undefined): UserLogEntry[] {
	if (!conversationId || typeof window === "undefined") return []
	try {
		const raw = window.localStorage.getItem(userLogStorageKey(conversationId))
		if (!raw) return []
		const parsed: unknown = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed.filter(isUserLogEntry) : []
	} catch {
		return []
	}
}

/** Persist the user log for a conversation (SSR/quota-safe, never throws). */
export function saveUserLog(conversationId: string | undefined, log: readonly UserLogEntry[]): void {
	if (!conversationId || typeof window === "undefined") return
	try {
		window.localStorage.setItem(userLogStorageKey(conversationId), JSON.stringify(log))
	} catch {
		// Ignore storage quota / private-mode failures — the live overlay still works.
	}
}

/** Render a stored user entry as a Flue-shaped `UIMessage`. */
export function makeUserMessage(entry: UserLogEntry): UIMessage {
	return {
		id: entry.id,
		role: "user",
		parts: [{ type: "text", text: entry.text, state: "done" }],
	}
}

/**
 * Interleave the client-owned user messages with Flue's assistant transcript.
 *
 * Flue's `messages` contain only assistant turns (each assistant turn collects its
 * own text + tool parts; a single submission can yield several turns when tools are
 * used). We drop any transient/echoed user messages Flue surfaces and render our own
 * log instead, placing each user entry immediately before the assistant turn it
 * triggered using its `turnsBefore` anchor.
 */
export function mergeUserMessages(
	flueMessages: readonly UIMessage[],
	userLog: readonly UserLogEntry[],
): UIMessage[] {
	const assistantMessages = flueMessages.filter((message) => message.role === "assistant")
	const result: UIMessage[] = []
	let cursor = 0
	for (let i = 0; i < assistantMessages.length; i++) {
		while (cursor < userLog.length && userLog[cursor]!.turnsBefore <= i) {
			result.push(makeUserMessage(userLog[cursor]!))
			cursor++
		}
		result.push(assistantMessages[i]!)
	}
	// Trailing entries: just-sent messages whose assistant turn hasn't started yet.
	while (cursor < userLog.length) {
		result.push(makeUserMessage(userLog[cursor]!))
		cursor++
	}
	return result
}
