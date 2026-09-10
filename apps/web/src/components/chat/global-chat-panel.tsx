import { lazy, Suspense, useState } from "react"
import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "@maple/ui/components/ui/sheet"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { MapleMark } from "@maple/ui/components/icons/maple-mark"
import { MaximizeIcon } from "@/components/icons"
import { ensureStoredTab, useChatTabs } from "@/hooks/use-chat-tabs"
import { QUICK_CHAT_TAB_ID } from "./global-chat-constants"

const GlobalChatContent = lazy(() =>
	import("./global-chat-content").then((module) => ({ default: module.GlobalChatContent })),
)

function ChatConversationFallback() {
	return (
		<div className="flex flex-1 flex-col gap-3 p-4" aria-label="Loading chat conversation">
			<div className="h-16 w-3/4 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
			<div className="h-20 w-4/5 animate-pulse self-end rounded-md bg-muted motion-reduce:animate-none" />
			<div className="mt-auto h-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
		</div>
	)
}

export function GlobalChatPanel({
	orgId,
	onOpenChange,
}: {
	orgId: string
	onOpenChange: (open: boolean) => void
}) {
	const { createTab, renameTab } = useChatTabs(orgId)
	const [tabId, setTabId] = useState(QUICK_CHAT_TAB_ID)

	const handleCreate = () => {
		setTabId(createTab())
	}

	return (
		<Sheet open onOpenChange={onOpenChange}>
			<SheetPopup
				side="right"
				className="w-[calc(100%-(--spacing(12)))] sm:max-w-2xl"
				closeProps={{ className: "absolute end-2 top-1.5 z-10" }}
			>
				<SheetHeader className="h-11 flex-row items-center gap-1 border-b px-3 py-0 pe-11">
					<SheetTitle className="flex min-w-0 items-center gap-2 text-sm">
						<MapleMark aria-hidden size={16} className="shrink-0 text-primary" />
						<span className="truncate">
							Maple{" "}
							<span className="shimmer shimmer-color-primary shimmer-duration-3200 shimmer-spread-[2ch]">
								AI
							</span>
						</span>
					</SheetTitle>
					<SheetDescription className="sr-only">
						Ask about your services, traces, errors, and alerts.
					</SheetDescription>
					<div className="ms-auto flex items-center gap-1.5">
						<Tooltip>
							<TooltipTrigger
								render={<Button size="sm" variant="outline" onClick={handleCreate} />}
							>
								New chat
							</TooltipTrigger>
							<TooltipPopup side="bottom">Start a new conversation</TooltipPopup>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										size="icon-sm"
										variant="ghost"
										aria-label="Open full page"
										onClick={() => {
											ensureStoredTab(
												orgId,
												tabId,
												tabId === QUICK_CHAT_TAB_ID ? "Quick chat" : "New Chat",
											)
											onOpenChange(false)
										}}
										render={<Link to="/chat" search={{ tab: tabId }} />}
									/>
								}
							>
								<MaximizeIcon className="size-4" />
							</TooltipTrigger>
							<TooltipPopup side="bottom">Open this chat in the full page view</TooltipPopup>
						</Tooltip>
						<div aria-hidden className="ms-0.5 h-4 w-px bg-border" />
					</div>
				</SheetHeader>
				<div className="flex min-h-0 flex-1 flex-col">
					<Suspense fallback={<ChatConversationFallback />}>
						<GlobalChatContent key={tabId} tabId={tabId} onFirstMessage={renameTab} />
					</Suspense>
				</div>
			</SheetPopup>
		</Sheet>
	)
}
