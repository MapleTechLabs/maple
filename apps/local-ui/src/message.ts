import * as Dialog from "@maple/web/ui/dialog"
import * as Popover from "@maple/web/ui/popover"
import * as Tabs from "@maple/web/ui/tabs"
import * as Toast from "@maple/web/ui/toast"
import * as CopyButton from "@maple/web/ui/copy-button"
import { Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { UrlRequest } from "foldkit/navigation"
import { Url } from "foldkit/url"
import { LoadFailure } from "./data/local-query"
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
