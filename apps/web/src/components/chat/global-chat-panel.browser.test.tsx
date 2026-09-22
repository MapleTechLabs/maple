// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ComponentProps, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { createTab, ensureStoredTab, renameTab } = vi.hoisted(() => ({
	createTab: vi.fn(() => "new-tab"),
	ensureStoredTab: vi.fn(),
	renameTab: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		onClick,
		search,
		to: _to,
		...props
	}: Omit<ComponentProps<"a">, "href"> & { search: { tab?: string }; to: string }) => (
		<a
			{...props}
			href={`/chat?tab=${search.tab ?? ""}`}
			data-tab={search.tab}
			onClick={(event) => {
				event.preventDefault()
				onClick?.(event)
			}}
		>
			{children}
		</a>
	),
}))

vi.mock("@maple/ui/components/ui/sheet", () => {
	const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
	return {
		Sheet: Passthrough,
		SheetDescription: Passthrough,
		SheetHeader: Passthrough,
		SheetPopup: Passthrough,
		SheetTitle: Passthrough,
	}
})

vi.mock("@/hooks/use-chat-tabs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks/use-chat-tabs")>()
	return {
		ensureStoredTab,
		loadSheetTab: actual.loadSheetTab,
		saveSheetTab: actual.saveSheetTab,
		useChatTabs: () => ({ createTab, renameTab }),
	}
})

vi.mock("./global-chat-content", () => ({
	GlobalChatContent: ({
		tabId,
		onFirstMessage,
	}: {
		tabId: string
		onFirstMessage?: (tabId: string, text: string) => void
	}) => (
		<div data-testid="conversation" data-tab={tabId}>
			<button type="button" onClick={() => onFirstMessage?.(tabId, "Investigate checkout latency")}>
				Send first message
			</button>
		</div>
	),
}))

import { GlobalChatPanel } from "./global-chat-panel"

const { ensureStoredTab: registerStoredTab } =
	await vi.importActual<typeof import("@/hooks/use-chat-tabs")>("@/hooks/use-chat-tabs")

afterEach(cleanup)

describe("GlobalChatPanel", () => {
	beforeEach(() => {
		localStorage.clear()
		createTab.mockClear()
		ensureStoredTab.mockClear()
		renameTab.mockClear()
	})

	it("reopens on the conversation it last showed", async () => {
		// The real createTab registers the new tab; the mock only returns its id.
		createTab.mockImplementationOnce(() => {
			registerStoredTab("org-1", "new-tab", "New Chat")
			return "new-tab"
		})
		const first = render(<GlobalChatPanel orgId="org-1" onOpenChange={vi.fn()} />)
		expect((await screen.findByTestId("conversation")).dataset.tab).toBe("quick")
		fireEvent.click(screen.getByRole("button", { name: "New chat" }))
		expect(screen.getByTestId("conversation").dataset.tab).toBe("new-tab")
		first.unmount()

		render(<GlobalChatPanel orgId="org-1" onOpenChange={vi.fn()} />)
		expect((await screen.findByTestId("conversation")).dataset.tab).toBe("new-tab")
		cleanup()

		// Another org never inherits the tab.
		render(<GlobalChatPanel orgId="org-2" onOpenChange={vi.fn()} />)
		expect((await screen.findByTestId("conversation")).dataset.tab).toBe("quick")
	})

	it("falls back to the quick thread when the remembered tab was closed", async () => {
		localStorage.setItem("maple-chat-sheet-tab:org-1", "gone")
		render(<GlobalChatPanel orgId="org-1" onOpenChange={vi.fn()} />)
		expect((await screen.findByTestId("conversation")).dataset.tab).toBe("quick")
	})

	it("creates and opens a fresh conversation from the AI sheet", async () => {
		const onOpenChange = vi.fn()
		render(<GlobalChatPanel orgId="org-1" onOpenChange={onOpenChange} />)

		expect((await screen.findByTestId("conversation")).dataset.tab).toBe("quick")

		fireEvent.click(screen.getByRole("button", { name: "New chat" }))

		expect(createTab).toHaveBeenCalledOnce()
		expect(screen.getByTestId("conversation").dataset.tab).toBe("new-tab")

		fireEvent.click(screen.getByRole("button", { name: "Send first message" }))
		expect(renameTab).toHaveBeenCalledWith("new-tab", "Investigate checkout latency")

		fireEvent.click(screen.getByRole("link", { name: "Open full page" }))
		expect(ensureStoredTab).toHaveBeenCalledWith("org-1", "new-tab", "New Chat")
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})
})
