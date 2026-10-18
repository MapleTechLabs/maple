import * as Popover from "@maple/web-foldkit/ui/popover"
import * as Toast from "@maple/web-foldkit/ui/toast"
import * as CopyButton from "@maple/web-foldkit/ui/copy-button"
import { Schema } from "effect"
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
	ClickedToggleSidebar: {},
	PressedSidebarShortcut: {},
	CompletedSaveSidebarState: {},
	GotConnectMessage: { message: Popover.Message },
	ChangedColorScheme: { theme: Theme },
	CompletedApplyTheme: {},
	SucceededFetchSignalPresence: { result: PresenceResult },
	FailedFetchSignalPresence: { failure: LoadFailure },
	ReusedSignalPresence: {},
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
	GotToastMessage: { message: Toast.Message },
	GotPageMessage: { message: PageMessage },
})
export type Message = typeof Message.Type
