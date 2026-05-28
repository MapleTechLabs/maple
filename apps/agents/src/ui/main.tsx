import { useLiveQuery } from "@tanstack/react-db"
import { StrictMode, useCallback, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { Message } from "../server/schema.js"
import {
	type AgentsCollection,
	type MessagesCollection,
	useChatroom,
} from "./hooks/useChatroom.js"
import { useEntityTypes } from "./hooks/useEntityTypes.js"
import "./main.css"

interface Room {
	id: string
	name: string
	agentCount: number
	createdAt: number
}

// Stable color per sender so each philosopher reads distinctly.
const AVATAR_COLORS = ["#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#8b5cf6", "#ef4444"]
function colorFor(name: string): string {
	let h = 0
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
	return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!
}
function initials(name: string): string {
	return name.slice(0, 2).toUpperCase()
}

function getRoomFromHash(): string | null {
	return window.location.hash.slice(1) || null
}

function MessageList({ collection }: { collection: MessagesCollection }) {
	const { data: messages = [] } = useLiveQuery(
		(q) =>
			q
				.from({ m: collection })
				.orderBy(({ m }) => (m as any).timestamp, "asc")
				.select(({ m }) => m),
		[collection],
	)
	const bottomRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" })
	}, [messages.length])

	if (messages.length === 0) {
		return <div className="empty">Send a message to start the conversation…</div>
	}

	return (
		<>
			{(messages as Message[]).map((m) => {
				const mine = m.role === "user"
				return (
					<div key={m.key} className={`msg ${mine ? "msg-user" : "msg-agent"}`}>
						<div className="avatar" style={{ background: mine ? "#334155" : colorFor(m.senderName) }}>
							{mine ? "🧑" : initials(m.senderName)}
						</div>
						<div className="bubble">
							<div className="sender">{m.senderName}</div>
							<div className="text">{m.text}</div>
						</div>
					</div>
				)
			})}
			<div ref={bottomRef} />
		</>
	)
}

function Members({
	collection,
	types,
	onSpawn,
}: {
	collection: AgentsCollection
	types: Array<{ name: string; description: string }>
	onSpawn: (type: string) => void
}) {
	const { data: agents = [] } = useLiveQuery(
		(q) => q.from({ a: collection }).select(({ a }) => a),
		[collection],
	)
	const present = new Set(agents.map((a: any) => a.type))
	return (
		<div className="members">
			<div className="panel-title">In the room</div>
			{agents.length === 0 && <div className="muted">No agents yet</div>}
			{agents.map((a: any) => (
				<div key={a.url} className="member">
					<span className="avatar sm" style={{ background: colorFor(a.type) }}>
						{initials(a.type)}
					</span>
					<span className="member-name">{a.type}</span>
					<span className={`dot ${a.status === "running" ? "dot-on" : ""}`} title={a.status} />
				</div>
			))}
			<div className="panel-title" style={{ marginTop: 16 }}>
				Add an agent
			</div>
			{types.map((t) => (
				<button
					type="button"
					key={t.name}
					className="add-btn"
					disabled={present.has(t.name)}
					title={t.description}
					onClick={() => onSpawn(t.name)}
				>
					+ {t.name}
				</button>
			))}
		</div>
	)
}

function App() {
	const [config, setConfig] = useState<{ agentsUrl: string } | null>(null)
	const [rooms, setRooms] = useState<Room[]>([])
	const [activeRoomId, setActiveRoomId] = useState<string | null>(getRoomFromHash)
	const [input, setInput] = useState("")
	const [newRoom, setNewRoom] = useState("")

	useEffect(() => {
		fetch("/api/config")
			.then((r) => r.json())
			.then((c) => setConfig(c))
			.catch((err) => console.error("Config failed:", err))
	}, [])

	const loadRooms = useCallback(async () => {
		try {
			const res = await fetch("/api/rooms")
			if (res.ok) setRooms(await res.json())
		} catch {}
	}, [])
	useEffect(() => {
		loadRooms()
	}, [loadRooms])

	useEffect(() => {
		window.location.hash = activeRoomId ?? ""
	}, [activeRoomId])

	const { messagesCollection, agentsCollection, connected, error } = useChatroom(
		config?.agentsUrl ?? null,
		activeRoomId,
	)
	const entityTypes = useEntityTypes(config?.agentsUrl ?? null)
	const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? null

	const createRoom = useCallback(async () => {
		const res = await fetch("/api/rooms", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: newRoom || undefined }),
		})
		if (res.ok) {
			const room: Room = await res.json()
			setRooms((prev) => [...prev, room])
			setActiveRoomId(room.id)
			setNewRoom("")
		}
	}, [newRoom])

	const send = useCallback(async () => {
		const text = input.trim()
		if (!text || !activeRoomId) return
		setInput("")
		await fetch(`/api/rooms/${activeRoomId}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		})
	}, [input, activeRoomId])

	const spawn = useCallback(
		async (type: string) => {
			if (!activeRoomId) return
			await fetch(`/api/rooms/${activeRoomId}/agent`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type }),
			})
		},
		[activeRoomId],
	)

	if (!config) return <div className="loading">connecting…</div>

	return (
		<div className="layout">
			<aside className="rooms">
				<div className="brand">
					🍁 <span>Agents Chat</span>
				</div>
				<div className="new-room">
					<input
						value={newRoom}
						placeholder="New room…"
						onChange={(e) => setNewRoom(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && createRoom()}
					/>
					<button type="button" onClick={createRoom}>
						+
					</button>
				</div>
				<div className="room-list">
					{rooms.map((r) => (
						<button
							type="button"
							key={r.id}
							className={`room ${r.id === activeRoomId ? "active" : ""}`}
							onClick={() => setActiveRoomId(r.id)}
						>
							# {r.name}
						</button>
					))}
					{rooms.length === 0 && <div className="muted pad">Create a room to start →</div>}
				</div>
			</aside>

			<main className="chat">
				<header className="chat-header">
					{activeRoom ? (
						<>
							<span className="hash">#</span> {activeRoom.name}
							<span className={`status ${connected ? "ok" : ""}`}>
								{connected ? "live" : "connecting…"}
							</span>
						</>
					) : (
						<span className="muted">Select or create a room</span>
					)}
				</header>
				{error && <div className="error">{error}</div>}
				<div className="messages">
					{messagesCollection ? (
						<MessageList collection={messagesCollection} />
					) : activeRoomId ? (
						<div className="empty">Connecting to room…</div>
					) : (
						<div className="empty">No room selected.</div>
					)}
				</div>
				<div className="composer">
					<input
						value={input}
						disabled={!activeRoomId}
						placeholder={
							activeRoomId
								? "Message the room — name an agent (e.g. “Camus, …”) to be sure they reply"
								: "Select a room first"
						}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && send()}
					/>
					<button type="button" onClick={send} disabled={!activeRoomId || !input.trim()}>
						Send
					</button>
				</div>
			</main>

			<aside className="sidebar">
				{agentsCollection ? (
					<Members collection={agentsCollection} types={entityTypes} onSpawn={spawn} />
				) : (
					<div className="muted pad">No room selected.</div>
				)}
			</aside>
		</div>
	)
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
