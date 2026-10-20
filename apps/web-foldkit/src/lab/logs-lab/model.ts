import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Shell from "../../shell"
import * as LogsStream from "../../ui/logs/logs-stream"
import * as Menu from "../../ui/menu"
import * as Toast from "../../ui/toast"

/** The lab's header toggles, pins aside. */
export const Toggle = Schema.Literals(["Wrap", "Comfortable", "Search", "Empty"])
export type Toggle = typeof Toggle.Type

export const PIN_OPTIONS = ["k8s.pod.name", "user.id", "http.route"] as const

// MODEL

export const Model = Schema.Struct({
	stream: LogsStream.Model,
	footerText: Schema.String,
	timeZone: Schema.String,
	locale: Schema.String,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** Auto-refresh cadence in seconds, 0 for off. */
	refreshInterval: Schema.Number,
	refreshMenu: Menu.Model,
	isInspecting: Schema.Boolean,
	isScrolledAway: Schema.Boolean,
	wrap: Schema.Boolean,
	density: Schema.Literals(["compact", "comfortable"]),
	search: Schema.Option(Schema.String),
	pinned: Schema.Array(Schema.String),
	isEmpty: Schema.Boolean,
	attrs: Schema.Array(Schema.String),
	toasts: Toast.Model,
	/** The real app shell around the page. */
	shell: Shell.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
	GotStreamMessage: { message: LogsStream.Message },
	ClickedToggle: { toggle: Toggle },
	ClickedPin: { key: Schema.String },
	ClickedReload: {},
	ClickedJumpToLatest: {},
	TickedAutoRefresh: {},
	ElapsedReloadSpin: { version: Schema.Number },
	GotToastMessage: { message: Toast.Message },
	GotShellMessage: { message: Shell.Message },
	GotRefreshMenuMessage: { message: Menu.Message },
})
export type Message = typeof Message.Type
