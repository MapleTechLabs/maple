import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationLoadingSkeleton,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Message, MessageContent } from "@/components/ai-elements/message"
import {
	PromptInput,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input"
import { RichText } from "@/components/ai-elements/rich-text"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import { ThinkingIndicator } from "@/components/ai-elements/thinking-indicator"
import { Tool } from "@/components/ai-elements/tool"
import { ToolGroup } from "@/components/ai-elements/tool-group"
import { useTypeAnywhereFocus } from "@/hooks/use-type-anywhere-focus"
import { useLiveQuery } from "@tanstack/react-db"
import { useEffect, useRef, useState } from "react"
import { CHAT_REST } from "./config"
import type { ChatMessage } from "./schema"
import { type ToolRecord, useAssistantStream, useChatroom } from "./use-electric-chat"

// Tailored to the Electric assistant's two tools (list_services, find_errors) — it can't
// serve the main chat's trace/log suggestions.
const DEFAULT_SUGGESTIONS = [
	"What services are running right now?",
	"Are there any errors lately?",
	"Which services have the highest error rate?",
	"Show throughput and P95 latency by service",
]

// Map our Electric tool status onto the UIMessage tool `state` the <Tool> card expects.
function toToolState(status: string): string {
	if (status === "completed") return "output-available"
	if (status === "failed" || status === "error") return "output-error"
	return "input-available" // started / args_complete / executing → "running"
}

// Render full tool cards (name, args, output) — same UI as the non-Electric /chat.
// A single tool renders one card; multiple collapse into a ToolGroup.
function ToolsView({ tools }: { tools: ReadonlyArray<ToolRecord> }) {
	if (tools.length === 0) return null
	const cards = tools.map((t, i) => {
		const state = toToolState(t.status)
		return (
			<Tool
				key={t.toolCallId ?? `${t.name}-${i}`}
				toolName={t.name}
				toolCallId={t.toolCallId ?? `${t.name}-${i}`}
				state={state}
				input={t.args}
				output={t.result}
				errorText={t.error}
			/>
		)
	})
	if (tools.length === 1) return <>{cards}</>
	const runningCount = tools.filter((t) => toToolState(t.status) === "input-available").length
	const errorCount = tools.filter((t) => toToolState(t.status) === "output-error").length
	return (
		<ToolGroup count={tools.length} runningCount={runningCount} errorCount={errorCount} defaultOpen={runningCount > 0}>
			{cards}
		</ToolGroup>
	)
}

export function ElectricConversation({
	roomId,
	onFirstMessage,
	onWorkingChange,
	onRoomMissing,
}: {
	roomId: string
	onFirstMessage?: (text: string) => void
	onWorkingChange?: (working: boolean) => void
	// The backend lost this room (in-memory, wiped on restart). Mint a fresh room for
	// this conversation and return its id so the message can be resent there.
	onRoomMissing?: () => Promise<string | undefined>
}) {
	const { messagesCollection, connected, error } = useChatroom(roomId)
	const { working, text: streamingText, tools: liveTools } = useAssistantStream(roomId)

	// Report the assistant's working state up so the sidebar can show a loading indicator.
	useEffect(() => {
		onWorkingChange?.(working)
	}, [working, onWorkingChange])

	// Focus the composer on mount / conversation switch, and when the user starts typing
	// anywhere (mirrors the non-Electric chat).
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	useTypeAnywhereFocus(textareaRef, true)
	useEffect(() => {
		textareaRef.current?.focus()
	}, [roomId])

	const { data: messages = [] } = useLiveQuery(
		messagesCollection
			? (q) =>
					q
						.from({ m: messagesCollection })
						.orderBy(({ m }) => (m as any).timestamp, "asc")
						.select(({ m }) => m)
			: () => null,
		[messagesCollection],
	)
	const typedMessages = messages as ChatMessage[]
	const lastMessage = typedMessages.at(-1)

	// Local "submitted" state bridges the gap between POSTing a message and the assistant
	// stream reporting `working` — without it the UI shows no feedback for that window.
	const [pending, setPending] = useState(false)
	const [pendingText, setPendingText] = useState<string | null>(null)
	useEffect(() => {
		// Clear once the assistant takes over (working) or its reply has synced in. Note we
		// deliberately don't clear on a synced *user* message — that would hide the indicator
		// before the agent starts.
		if (working || lastMessage?.role === "agent") {
			setPending(false)
			setPendingText(null)
		}
	}, [working, lastMessage?.role])

	// Avoid an empty-state flash before the Electric collection connects.
	const [hasSettled, setHasSettled] = useState(false)
	useEffect(() => {
		if (messages.length > 0) {
			setHasSettled(true)
			return
		}
		const t = setTimeout(() => setHasSettled(true), 600)
		return () => clearTimeout(t)
	}, [messages.length])

	const postMessage = (id: string, text: string) =>
		fetch(`${CHAT_REST}/api/rooms/${id}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		})

	const send = (textValue: string) => {
		const trimmed = textValue.trim()
		if (!trimmed || working || pending) return
		// First user message titles the conversation in the sidebar.
		if (messages.length === 0) onFirstMessage?.(trimmed)
		setPending(true)
		setPendingText(trimmed)
		void (async () => {
			try {
				let res = await postMessage(roomId, trimmed)
				// Room gone (backend restarted): mint a fresh one and resend there. That
				// swaps the active id, so this conversation remounts onto the new room.
				if (res.status === 404 && onRoomMissing) {
					const newId = await onRoomMissing()
					if (newId) res = await postMessage(newId, trimmed)
				}
				if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
			} catch (err) {
				console.error("Failed to send Electric message:", err)
				setPending(false)
				setPendingText(null)
			}
		})()
	}

	// "thinking" covers both the local submitted window and the live turn, until the first token.
	const showThinking = (working || pending) && streamingText.trim().length === 0
	const showStreaming = working && streamingText.trim().length > 0
	const busy = working || pending
	// Optimistic echo of the just-sent message until Electric syncs the real copy back.
	const showOptimisticUser = pending && pendingText != null && lastMessage?.text !== pendingText

	return (
		<div className="flex h-full flex-col">
			{error && (
				<div className="px-4 py-2 text-destructive text-xs">{error}</div>
			)}
			<Conversation className="flex-1 min-h-0">
				<ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
					{!hasSettled && messages.length === 0 ? (
						<ConversationLoadingSkeleton />
					) : (
						messages.length === 0 &&
						!busy && (
							<ConversationEmptyState>
								<div className="mt-4 flex flex-col items-center gap-3">
									<div className="space-y-1 text-center">
										<h3 className="font-medium text-sm">Ask Maple anything</h3>
										<p className="text-muted-foreground text-sm">
											{connected
												? "Pick a suggestion or ask your own question."
												: "Connecting to the assistant…"}
										</p>
									</div>
									<Suggestions className="mt-2 justify-center">
										{DEFAULT_SUGGESTIONS.map((s) => (
											<Suggestion key={s} suggestion={s} onClick={() => send(s)} />
										))}
									</Suggestions>
								</div>
							</ConversationEmptyState>
						)
					)}

					{typedMessages.map((m) => (
						<Message key={m.key} from={m.role === "user" ? "user" : "assistant"}>
							<MessageContent>
								{m.tools && m.tools.length > 0 && <ToolsView tools={m.tools} />}
								{m.role === "user" ? m.text : <RichText>{m.text}</RichText>}
							</MessageContent>
						</Message>
					))}

					{showOptimisticUser && (
						<Message from="user">
							<MessageContent>{pendingText}</MessageContent>
						</Message>
					)}

					{(showThinking || showStreaming) && (
						<Message from="assistant">
							<MessageContent>
								{liveTools.length > 0 && <ToolsView tools={liveTools} />}
								{showStreaming ? <RichText>{streamingText}</RichText> : <ThinkingIndicator />}
							</MessageContent>
						</Message>
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>

			<div className="mx-auto w-full max-w-3xl px-4 pb-4">
				{messages.length > 0 && (
					<Suggestions className="mb-3">
						{DEFAULT_SUGGESTIONS.map((s) => (
							<Suggestion key={s} suggestion={s} onClick={() => send(s)} />
						))}
					</Suggestions>
				)}
				<PromptInput onSubmit={({ text }) => send(text)}>
					<PromptInputTextarea
						ref={textareaRef}
						autoFocus
						disabled={busy}
						placeholder="Message Maple…"
					/>
					<PromptInputFooter>
						<PromptInputSubmit
							disabled={busy}
							status={working ? "streaming" : pending ? "submitted" : "ready"}
						/>
					</PromptInputFooter>
				</PromptInput>
			</div>
		</div>
	)
}
