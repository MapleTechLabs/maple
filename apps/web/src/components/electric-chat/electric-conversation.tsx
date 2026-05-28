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
import { cn } from "@/lib/utils"
import { GearIcon } from "@/components/icons"
import { useLiveQuery } from "@tanstack/react-db"
import { CHAT_REST } from "./config"
import type { ChatMessage } from "./schema"
import { type LiveTool, useAssistantStream, useChatroom } from "./use-electric-chat"

function ToolChip({ tool }: { tool: LiveTool }) {
	const running = tool.status !== "completed" && tool.status !== "failed"
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
				tool.status === "failed"
					? "border-destructive/40 text-destructive"
					: "border-border text-muted-foreground",
			)}
		>
			<GearIcon className={cn("size-3", running && "animate-spin")} />
			<span className="font-mono">{tool.name}</span>
			<span className="opacity-60">{tool.status}</span>
		</span>
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
								{m.role === "user" ? m.text : <RichText>{m.text}</RichText>}
								{m.tools && m.tools.length > 0 && (
									<div className="mt-1 flex flex-wrap gap-1.5">
										{m.tools.map((t, i) => (
											<ToolChip key={`${t.name}-${i}`} tool={t} />
										))}
									</div>
								)}
							</MessageContent>
						</Message>
					))}

					{(showThinking || showStreaming) && (
						<Message from="assistant">
							<MessageContent>
								{liveTools.length > 0 && (
									<div className="mb-1 flex flex-wrap gap-1.5">
										{liveTools.map((t, i) => (
											<ToolChip key={`live-${t.name}-${i}`} tool={t} />
										))}
									</div>
								)}
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
