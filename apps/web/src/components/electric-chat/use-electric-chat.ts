import { createAgentsClient, db, entity } from "@electric-ax/agents-runtime"
import type { EntityStreamDB } from "@electric-ax/agents-runtime"
import { useChat } from "@electric-ax/agents-runtime/react"
import type { Collection } from "@tanstack/db"
import { useEffect, useState } from "react"
import { AGENTS_URL, assistantEntityUrl } from "./config"
import { chatroomSchema, type ChatMessage } from "./schema"

export type MessagesCollection = Collection<ChatMessage>

export interface LiveTool {
	name: string
	status: string
}

async function retry<T>(fn: () => Promise<T>, attempts = 15, delay = 1000): Promise<T> {
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn()
		} catch (err) {
			if (i === attempts - 1) throw err
			await new Promise((r) => setTimeout(r, delay))
		}
	}
	throw new Error("Unreachable")
}

/** Observe a conversation's shared chatroom (committed user + assistant messages), live. */
export function useChatroom(roomId: string | null) {
	const [messagesCollection, setMessagesCollection] = useState<MessagesCollection | null>(null)
	const [connected, setConnected] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!roomId) {
			setMessagesCollection(null)
			setConnected(false)
			return
		}
		let cancelled = false
		let close: (() => void) | undefined

		;(async () => {
			try {
				const client = createAgentsClient({ baseUrl: AGENTS_URL })
				const chatroomDb = await retry(async () => {
					if (cancelled) throw new Error("cancelled")
					return await client.observe(db(roomId, chatroomSchema))
				})
				close = () => (chatroomDb as any).close?.()
				if (!cancelled) {
					setMessagesCollection((chatroomDb as any).collections.messages as MessagesCollection)
					setConnected(true)
					setError(null)
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err))
					setConnected(false)
				}
			}
		})()

		return () => {
			cancelled = true
			close?.()
		}
	}, [roomId])

	return { messagesCollection, connected, error }
}

/**
 * Observe the conversation's assistant entity timeline for live turn state:
 * `working` (thinking/typing), the streaming `text`, and in-flight `tools`.
 */
export function useAssistantStream(roomId: string | null) {
	const [entityDb, setEntityDb] = useState<EntityStreamDB | null>(null)

	useEffect(() => {
		if (!roomId) {
			setEntityDb(null)
			return
		}
		let cancelled = false
		let observed: EntityStreamDB | null = null
		const client = createAgentsClient({ baseUrl: AGENTS_URL })
		client
			.observe(entity(assistantEntityUrl(roomId)))
			.then((dbHandle) => {
				observed = dbHandle as EntityStreamDB
				if (cancelled) observed.close()
				else setEntityDb(observed)
			})
			.catch((err) => {
				if (!cancelled) console.error("Failed to observe assistant entity:", err)
			})
		return () => {
			cancelled = true
			observed?.close()
		}
	}, [roomId])

	const { state, runs } = useChat(entityDb)
	const working = state === "working"

	let text = ""
	let tools: LiveTool[] = []
	if (working && runs.length > 0) {
		const active = [...runs].reverse().find((r) => r.status === "started") ?? runs[runs.length - 1]
		if (active) {
			text = (active.texts ?? []).map((t) => t.text).join("")
			tools = (active.toolCalls ?? []).map((t: any) => ({
				name: t.tool_name as string,
				status: t.status as string,
			}))
		}
	}

	return { working, text, tools }
}
