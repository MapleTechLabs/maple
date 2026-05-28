import { useAuth } from "@clerk/clerk-react"
import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { Button } from "@maple/ui/components/ui/button"
import { SidebarInset, SidebarProvider } from "@maple/ui/components/ui/sidebar"
import { useCallback, useEffect, useRef, useState } from "react"
import { CHAT_REST } from "./config"
import { ElectricConversation } from "./electric-conversation"

interface ElectricChatPageProps {
	urlConversationId?: string
}

export function ElectricChatPage({ urlConversationId }: ElectricChatPageProps) {
	const { orgId } = useAuth()
	if (!orgId) return null
	return <ElectricChatPageInner orgId={orgId} urlConversationId={urlConversationId} />
}

const storageKey = (orgId: string) => `maple-electric-chat:${orgId}`

function ElectricChatPageInner({ orgId, urlConversationId }: { orgId: string; urlConversationId?: string }) {
	const [conversationId, setConversationId] = useState<string | null>(
		() => urlConversationId ?? (typeof window === "undefined" ? null : localStorage.getItem(storageKey(orgId))),
	)
	const [creating, setCreating] = useState(false)
	const createGuard = useRef(false)

	const createConversation = useCallback(async () => {
		if (createGuard.current) return
		createGuard.current = true
		setCreating(true)
		try {
			const res = await fetch(`${CHAT_REST}/api/rooms`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "assistant", agent: "assistant", orgId }),
			})
			if (!res.ok) throw new Error(await res.text())
			const room = (await res.json()) as { id: string }
			localStorage.setItem(storageKey(orgId), room.id)
			setConversationId(room.id)
		} catch (err) {
			console.error("Failed to create Electric conversation:", err)
		} finally {
			setCreating(false)
			createGuard.current = false
		}
	}, [orgId])

	// Ensure a conversation exists on first load.
	useEffect(() => {
		if (!conversationId && !creating) void createConversation()
	}, [conversationId, creating, createConversation])

	// Reflect the conversation in the URL (?conversation=) without re-rendering the route.
	useEffect(() => {
		if (!conversationId || typeof window === "undefined") return
		const url = new URL(window.location.href)
		if (url.searchParams.get("conversation") === conversationId) return
		url.searchParams.set("conversation", conversationId)
		window.history.replaceState(window.history.state, "", url.toString())
	}, [conversationId])

	const newConversation = useCallback(() => {
		setConversationId(null)
		localStorage.removeItem(storageKey(orgId))
	}, [orgId])

	return (
		<SidebarProvider open={false} onOpenChange={() => {}} className="h-svh overflow-hidden">
			<AppSidebar />
			<SidebarInset>
				<div className="flex h-full min-w-0 flex-1 flex-col">
					<div className="flex items-center justify-between border-b px-4 py-2.5">
						<div className="flex items-center gap-2 text-sm">
							<span className="font-medium">Chat (Electric)</span>
							<span className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs">
								Electric Agents · comparison
							</span>
						</div>
						<Button size="sm" variant="outline" onClick={newConversation}>
							New conversation
						</Button>
					</div>
					<div className="relative min-h-0 flex-1 bg-background">
						{conversationId ? (
							<ElectricConversation key={conversationId} roomId={conversationId} />
						) : (
							<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
								{creating ? "Starting a conversation…" : "Preparing…"}
							</div>
						)}
					</div>
				</div>
			</SidebarInset>
		</SidebarProvider>
	)
}
