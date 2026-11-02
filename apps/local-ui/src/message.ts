import * as Dialog from "@maple/views/ui/dialog"
import * as Popover from "@maple/views/ui/popover"
import * as Tabs from "@maple/views/ui/tabs"
import * as Toast from "@maple/views/ui/toast"
import * as CopyButton from "@maple/views/ui/copy-button"
import { Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { UrlRequest } from "foldkit/navigation"
import { Url } from "foldkit/url"
import { LoadFailure } from "@maple/views/data/load-failure"
import { PresenceResult } from "./data/signal-presence"
import { Theme } from "./env"
import { PageMessage } from "./page/registry"
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
	GotFilterDrawerMessage: { message: Dialog.Message },
	GotConnectMessage: { message: Popover.Message },
	GotInstallTabsMessage: { message: Tabs.Message },
	ChangedColorScheme: { theme: Theme },
	CompletedApplyTheme: {},
	SucceededFetchSignalPresence: { result: PresenceResult },
	FailedFetchSignalPresence: { failure: LoadFailure },
	ReusedSignalPresence: {},
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
	GotToastMessage: { message: Toast.Message },
	GotPageMessage: { message: PageMessage },
	/** A request the open page superseded or left behind was stopped. */
	CompletedCancelPageFetch: { outcome: Command.Interruptible.Outcome },
})
export type Message = typeof Message.Type
