import { lazy, Suspense, useState } from "react"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { useMapleOrganizationId } from "@/hooks/use-maple-organization"
import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { ChatContentFallback } from "./chat-content-fallback"

const OPEN_CHAT_EVENT = "maple:open-chat-sheet"

const GlobalChatPanel = lazy(() =>
	import("./global-chat-panel").then((module) => ({ default: module.GlobalChatPanel })),
)

/** Open the global chat slide-over from anywhere (header button, ⌘K action). */
export function openGlobalChat() {
	document.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT))
}

/**
 * App-wide chat surface, mounted once in the root AppFrame: a right slide-over
 * hosting the Maple AI conversation. It opens on a persistent org-scoped
 * "quick" thread and can create fresh conversations without leaving the sheet.
 * Replaces the old sidebar nav entry — the full /chat page remains for deep
 * links (alert triage, widget fix, shared views) and multi-tab work.
 *
 * The popup content (and with it the Flue connection) only mounts while open;
 * history restores from the durable stream on reopen, same as AlertChatSheet.
 */
export function GlobalChatSheet() {
	const [open, setOpen] = useState(false)
	const orgId = useMapleOrganizationId()

	useMountEffect(() => {
		const onOpen = () => setOpen(true)
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "c" || event.metaKey || event.ctrlKey || event.altKey) return
			if (isEditableTarget(event.target) || isDialogOpen()) return
			event.preventDefault()
			setOpen(true)
		}
		document.addEventListener(OPEN_CHAT_EVENT, onOpen)
		document.addEventListener("keydown", onKeyDown)
		return () => {
			document.removeEventListener(OPEN_CHAT_EVENT, onOpen)
			document.removeEventListener("keydown", onKeyDown)
		}
	})

	if (!orgId) return null

	if (!open) return null

	return (
		<Suspense fallback={<ChatContentFallback label="Loading chat" />}>
			<GlobalChatPanel key={orgId} orgId={orgId} onOpenChange={setOpen} />
		</Suspense>
	)
}
