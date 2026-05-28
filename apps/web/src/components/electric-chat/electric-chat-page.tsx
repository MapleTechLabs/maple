import { useAuth } from "@clerk/clerk-react"
import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { ChatSidebar } from "@/components/chat/chat-sidebar"
import { SidebarInset, SidebarProvider } from "@maple/ui/components/ui/sidebar"
import { useCallback, useEffect, useState } from "react"
import { ElectricConversation } from "./electric-conversation"
import { useElectricConversations } from "./use-electric-conversations"

interface ElectricChatPageProps {
	urlConversationId?: string
}

export function ElectricChatPage({ urlConversationId }: ElectricChatPageProps) {
	const { orgId } = useAuth()
	if (!orgId) return null
	return <ElectricChatPageInner orgId={orgId} urlConversationId={urlConversationId} />
}

function ElectricChatPageInner({ orgId, urlConversationId }: { orgId: string; urlConversationId?: string }) {
	const { conversations, activeId, creating, create, recreate, select, close, rename, titleFromFirstMessage } =
		useElectricConversations(orgId, urlConversationId)

	// Loading indicator on the active conversation's sidebar row while its assistant
	// generates. Driven by the active conversation's own (single) live observer to avoid
	// a second observer on the same entity, which breaks live updates.
	const [activeWorking, setActiveWorking] = useState(false)
	const loadingTabIds: ReadonlySet<string> =
		activeWorking && activeId ? new Set([activeId]) : new Set()

	// Reflect the active conversation in the URL (?conversation=) without a route re-render.
	useEffect(() => {
		if (!activeId || typeof window === "undefined") return
		const url = new URL(window.location.href)
		if (url.searchParams.get("conversation") === activeId) return
		url.searchParams.set("conversation", activeId)
		window.history.replaceState(window.history.state, "", url.toString())
	}, [activeId])

	const onCreate = useCallback(() => {
		void create()
	}, [create])

	// Cmd/Ctrl+Shift+O starts a new conversation from anywhere (mirrors the non-Electric chat).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey
			if (!mod || !e.shiftKey) return
			if (e.key === "O" || e.key === "o") {
				e.preventDefault()
				void create()
			}
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [create])

	return (
		<SidebarProvider open={false} onOpenChange={() => {}} className="h-svh overflow-hidden">
			<AppSidebar />
			<SidebarInset>
				<div className="flex h-full min-h-0 flex-1">
					<ChatSidebar
						tabs={conversations}
						activeTabId={activeId}
						loadingTabIds={loadingTabIds}
						onSelect={select}
						onClose={close}
						onCreate={onCreate}
						onRename={rename}
					/>
					<div className="flex min-w-0 flex-1 flex-col">
						<div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm">
							<span className="font-medium">Chat (Electric)</span>
							<span className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs">
								Electric Agents · comparison
							</span>
						</div>
						<div className="relative min-h-0 flex-1 bg-background">
							{activeId ? (
								<ElectricConversation
									key={activeId}
									roomId={activeId}
									onFirstMessage={(text) => titleFromFirstMessage(activeId, text)}
									onWorkingChange={setActiveWorking}
									onRoomMissing={() => recreate(activeId)}
								/>
							) : (
								<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
									{creating ? "Starting a conversation…" : "No conversation selected."}
								</div>
							)}
						</div>
					</div>
				</div>
			</SidebarInset>
		</SidebarProvider>
	)
}
