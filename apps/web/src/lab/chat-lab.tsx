import { useMemo, useState } from "react"

import { cn } from "@maple/ui/lib/utils"

import {
	PromptInput,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input"
import type { AutoContext } from "@/components/chat/auto-contexts"
import { ChatTranscript } from "@/components/chat/chat-transcript"
import { PageContextChips } from "@/components/chat/page-context-chips"
import { buildChatLabMessages } from "@/lab/chat-fixture"

/**
 * The chat transcript without a model behind it.
 *
 * The component is the real one the `/chat` route and the global sheet mount, over
 * a thread that holds the states worth eyeballing together: a merged tool run, a
 * standalone call, prose carrying all four inline cards, an approval prompt, and
 * the two-character turns that expose the transcript's vertical rhythm.
 *
 * The width switcher matters more here than on most labs — the same transcript
 * renders in a 2xl side sheet and in a full-width page, and the inline cards lay
 * out their metrics on one line in both.
 */
const WIDTHS = [
	{ label: "Page (768px)", value: 768 },
	{ label: "Sheet (620px)", value: 620 },
	{ label: "Narrow (420px)", value: 420 },
] as const

/** The composer's context tray, holding a long subject and a subject-less chip. */
const LAB_CONTEXTS: AutoContext[] = [
	{ kind: "service_map", id: "service_map" },
	{ kind: "service", id: "service:checkout", serviceName: "checkout-api-eu-west" },
	{ kind: "trace", id: "trace:9f2c", traceId: "9f2c41b8ad0e4c1f" },
	{ kind: "container", id: "container:ingest", containerName: "ingest-gateway" },
]

export function ChatLab() {
	const messages = useMemo(() => buildChatLabMessages(), [])
	const [contexts, setContexts] = useState<AutoContext[]>(LAB_CONTEXTS)
	const [width, setWidth] = useState<number>(768)
	const [isLoading, setIsLoading] = useState(false)
	const [resolved, setResolved] = useState<Map<string, "applied" | "denied">>(() => new Map())

	return (
		<div className="flex h-screen flex-col bg-background">
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
				<span className="font-semibold">Chat transcript</span>
				{WIDTHS.map((option) => (
					<button
						key={option.label}
						type="button"
						onClick={() => setWidth(option.value)}
						className={cn(
							"rounded-md border px-2 py-1 transition-colors hover:bg-accent",
							width === option.value && "bg-accent",
						)}
					>
						{option.label}
					</button>
				))}
				<button
					type="button"
					onClick={() => setIsLoading((v) => !v)}
					className={cn(
						"rounded-md border px-2 py-1 transition-colors hover:bg-accent",
						isLoading && "bg-accent",
					)}
				>
					{isLoading ? "Streaming" : "Idle"}
				</button>
			</div>
			<div className="flex min-h-0 flex-1 justify-center">
				<div className="flex min-h-0 flex-col border-x" style={{ width }}>
					<ChatTranscript
						messages={messages}
						isLoading={isLoading}
						resolvedApprovals={resolved}
						onApprove={(_messageId, toolCallId) =>
							setResolved((prev) => new Map(prev).set(toolCallId, "applied"))
						}
						onDeny={(toolCallId) =>
							setResolved((prev) => new Map(prev).set(toolCallId, "denied"))
						}
						fallbackDiagnosis={null}
						readOnly={false}
						emptyState={<p className="text-sm text-muted-foreground">Nothing here yet.</p>}
					/>
					<div className="shrink-0 px-4 pb-4">
						<PromptInput onSubmit={() => {}}>
							<PageContextChips
								contexts={contexts}
								onDismiss={(id) => setContexts((prev) => prev.filter((c) => c.id !== id))}
							/>
							<PromptInputTextarea placeholder="Ask about your system…" />
							<PromptInputFooter>
								<PromptInputSubmit status={isLoading ? "streaming" : "ready"} />
							</PromptInputFooter>
						</PromptInput>
					</div>
				</div>
			</div>
		</div>
	)
}
