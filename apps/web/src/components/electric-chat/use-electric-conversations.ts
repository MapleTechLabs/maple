import { useCallback, useEffect, useRef, useState } from "react"
import { CHAT_REST } from "./config"

// A conversation IS a room (with one assistant agent) on the agents server. We keep the
// list + titles in localStorage per org, mirroring the non-Electric chat's tab sidebar.
export interface ElectricConversation {
	id: string
	title: string
	createdAt: number
	updatedAt: number
}

const storageKey = (orgId: string) => `maple-electric-chats:${orgId}`

function load(orgId: string): ElectricConversation[] {
	try {
		const raw = localStorage.getItem(storageKey(orgId))
		if (raw) {
			const parsed = JSON.parse(raw) as ElectricConversation[]
			if (Array.isArray(parsed)) return parsed
		}
	} catch {}
	return []
}

function save(orgId: string, list: ElectricConversation[]) {
	try {
		localStorage.setItem(storageKey(orgId), JSON.stringify(list))
	} catch {}
}

/** Create a room (spawns the assistant) and return its id. */
async function createRoom(orgId: string): Promise<string> {
	const res = await fetch(`${CHAT_REST}/api/rooms`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "assistant", agent: "assistant", orgId }),
	})
	if (!res.ok) throw new Error(await res.text())
	const room = (await res.json()) as { id: string }
	return room.id
}

export function useElectricConversations(orgId: string, initialId?: string) {
	const [conversations, setConversations] = useState<ElectricConversation[]>(() => load(orgId))
	const [activeId, setActiveId] = useState<string | null>(
		() => initialId ?? load(orgId)[0]?.id ?? null,
	)
	const [creating, setCreating] = useState(false)
	const createGuard = useRef(false)

	// Reload when the org changes.
	const lastOrg = useRef(orgId)
	useEffect(() => {
		if (lastOrg.current === orgId) return
		lastOrg.current = orgId
		const list = load(orgId)
		setConversations(list)
		setActiveId(list[0]?.id ?? null)
	}, [orgId])

	const persist = useCallback(
		(updater: (prev: ElectricConversation[]) => ElectricConversation[]) => {
			setConversations((prev) => {
				const next = updater(prev)
				save(orgId, next)
				return next
			})
		},
		[orgId],
	)

	const create = useCallback(async (): Promise<string | undefined> => {
		if (createGuard.current) return undefined
		createGuard.current = true
		setCreating(true)
		try {
			const id = await createRoom(orgId)
			const now = Date.now()
			persist((prev) => [...prev, { id, title: "New Chat", createdAt: now, updatedAt: now }])
			setActiveId(id)
			return id
		} catch (err) {
			console.error("Failed to create Electric conversation:", err)
			return undefined
		} finally {
			setCreating(false)
			createGuard.current = false
		}
	}, [orgId, persist])

	// Ensure at least one conversation exists on first load.
	useEffect(() => {
		if (conversations.length === 0 && !creating) void create()
	}, [conversations.length, creating, create])

	// The agents backend keeps rooms in memory, so a `tsx watch` reload (or a port
	// change) wipes them while our localStorage ids live on — sending to a dead room
	// 404s. Recover by minting a fresh room for the same conversation slot and
	// swapping its id in place. History on the old durable stream is abandoned (the
	// backend lost the room), but the conversation keeps working.
	const recreate = useCallback(
		async (oldId: string): Promise<string | undefined> => {
			try {
				const newId = await createRoom(orgId)
				persist((prev) => prev.map((c) => (c.id === oldId ? { ...c, id: newId } : c)))
				setActiveId((cur) => (cur === oldId ? newId : cur))
				return newId
			} catch (err) {
				console.error("Failed to recreate Electric conversation room:", err)
				return undefined
			}
		},
		[orgId, persist],
	)

	const select = useCallback((id: string) => setActiveId(id), [])

	const close = useCallback(
		(id: string) => {
			setConversations((prev) => {
				if (prev.length <= 1) return prev
				const idx = prev.findIndex((c) => c.id === id)
				if (idx === -1) return prev
				const next = prev.filter((c) => c.id !== id)
				save(orgId, next)
				setActiveId((cur) => (cur === id ? next[Math.min(idx, next.length - 1)]!.id : cur))
				return next
			})
		},
		[orgId],
	)

	const rename = useCallback(
		(id: string, title: string) => {
			persist((prev) => prev.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c)))
		},
		[persist],
	)

	// Set a title from the first user message (only while still the default).
	const titleFromFirstMessage = useCallback(
		(id: string, text: string) => {
			persist((prev) =>
				prev.map((c) =>
					c.id === id && c.title === "New Chat"
						? { ...c, title: text.slice(0, 60), updatedAt: Date.now() }
						: c,
				),
			)
		},
		[persist],
	)

	return { conversations, activeId, creating, create, recreate, select, close, rename, titleFromFirstMessage }
}
