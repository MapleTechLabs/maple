import { Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { UrlRequest } from "foldkit/navigation"
import { Url } from "foldkit/url"
import { LoadFailure } from "./data/local-query"
import { PresenceResult } from "./data/signal-presence"
import { CopyMessage } from "./page/kit/copies"
import { Theme } from "./env"
import { ProbeOutcome } from "./server/state"

export const Message = defineMessageUnion({
	ClickedLink: { request: UrlRequest },
	ChangedUrl: { url: Url },
	CompletedNavigate: {},
	CompletedRememberRange: {},
	CompletedProbeServer: { outcome: ProbeOutcome, checkedAtMs: Schema.Number },
	ElapsedProbeDelay: { version: Schema.Number },
	ClickedRetryConnection: {},
	ClickedRetryStaleData: {},
	ClickedToggleSidebar: {},
	PressedSidebarShortcut: {},
	CompletedSaveSidebarState: {},
	ChangedViewport: { isMobile: Schema.Boolean },
	DismissedMobileNav: {},
	ChangedColorScheme: { theme: Theme },
	CompletedApplyTheme: {},
	SucceededFetchSignalPresence: { result: PresenceResult },
	FailedFetchSignalPresence: { failure: LoadFailure },
	ReusedSignalPresence: {},
	/** A fact of one of the shell's copy buttons (`copies`). */
	ReceivedCopyMessage: { message: CopyMessage },
	/** A request the open page superseded or left behind was stopped. */
	CompletedCancelPageFetch: { outcome: Command.Interruptible.Outcome },
})
export type Message = typeof Message.Type
