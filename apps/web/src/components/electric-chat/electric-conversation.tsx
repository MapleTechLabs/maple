import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
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
import { ThinkingIndicator } from "@/components/ai-elements/thinking-indicator"
import { Tool } from "@/components/ai-elements/tool"
import { ToolGroup } from "@/components/ai-elements/tool-group"
import { useLiveQuery } from "@tanstack/react-db"
import { CHAT_REST } from "./config"
import type { ChatMessage } from "./schema"
import { type ToolRecord, useAssistantStream, useChatroom } from "./use-electric-chat"

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

export function ElectricConversation({ roomId }: { roomId: string }) {
	const { messagesCollection, connected, error } = useChatroom(roomId)
	const { working, text: streamingText, tools: liveTools } = useAssistantStream(roomId)

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

	const send = (textValue: string) => {
		const trimmed = textValue.trim()
		if (!trimmed) return
		void fetch(`${CHAT_REST}/api/rooms/${roomId}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: trimmed }),
		})
	}

	// Show "thinking" only before the first streamed token of the active turn.
	const showThinking = working && streamingText.trim().length === 0
	const showStreaming = working && streamingText.trim().length > 0

	return (
		<div className="flex h-full flex-col">
			{error && (
				<div className="px-4 py-2 text-destructive text-xs">{error}</div>
			)}
			<Conversation className="flex-1 min-h-0">
				<ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
					{messages.length === 0 && !working && (
						<ConversationEmptyState
							title="Ask Maple anything"
							description={
								connected
									? "Try: “What services are running right now?”"
									: "Connecting to the assistant…"
							}
						/>
					)}

					{(messages as ChatMessage[]).map((m) => (
						<Message key={m.key} from={m.role === "user" ? "user" : "assistant"}>
							<MessageContent>
								{m.tools && m.tools.length > 0 && <ToolsView tools={m.tools} />}
								{m.role === "user" ? m.text : <RichText>{m.text}</RichText>}
							</MessageContent>
						</Message>
					))}

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
				<PromptInput onSubmit={({ text }) => send(text)}>
					<PromptInputTextarea placeholder="Message Maple…" />
					<PromptInputFooter>
						<PromptInputSubmit status={working ? "streaming" : "ready"} />
					</PromptInputFooter>
				</PromptInput>
			</div>
		</div>
	)
}
