import { DashboardShareMode, type TimeRange } from "@maple/domain/http"
import { isZoneDependentShorthand } from "@maple/query-engine"
import { AsyncData } from "foldkit"
import { Schema } from "effect"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as RadioGroup from "@maple/views/ui/radio-group"
import * as Tabs from "@maple/views/ui/tabs"
import { defineMessageUnion } from "foldkit/message"

// `ShareDashboardDialog` and `EmbedWidgetDialog`: the board's share
// links (`dashboardSharesAtom`), the access pick held until the server confirms it, and the writes.

export const ShareRow = Schema.Struct({
	widgetId: Schema.NullOr(Schema.String),
	mode: DashboardShareMode,
	token: Schema.String,
})
export type ShareRow = typeof ShareRow.Type

export const SharesData = AsyncData.Schema(Schema.Array(ShareRow), LoadFailure)
export type SharesData = typeof SharesData.schema.Type

export const Access = Schema.Literals(["off", "org", "public"])
export type Access = typeof Access.Type

/** A share write: the board's mode, a link replaced, a chart link minted. */
export const ShareWrite = Schema.Union([
	Schema.TaggedStruct("SetBoardMode", { access: Access }),
	Schema.TaggedStruct("RotateBoard", {}),
	Schema.TaggedStruct("RotateChart", { widgetId: Schema.String }),
	Schema.TaggedStruct("MintChart", { widgetId: Schema.String }),
])
export type ShareWrite = typeof ShareWrite.Type

export const SharingState = Schema.Struct({
	shares: SharesData.schema,
	/** `window.location.origin`, read when a dialog opens: links are `<origin>/share/<token>`. */
	origin: Schema.String,
	dialog: Dialog.Model,
	pendingAccess: Schema.NullOr(Access),
	isBusy: Schema.Boolean,
	error: Schema.NullOr(Schema.String),
	linkCopy: CopyButton.Model,
	replaceDialog: Dialog.Model,
	embedDialog: Dialog.Model,
	embedWidgetId: Schema.NullOr(Schema.String),
	embedTabs: Tabs.Model,
	snippetCopy: CopyButton.Model,
	/** `useState(() => Date.now())` in `EmbedUrlOptions`: the from/to example's clock. */
	embedNowMs: Schema.Number,
	/** "Make dashboard public" runs two writes; the chart link is minted after the board's. */
	queuedChart: Schema.NullOr(Schema.String),
	/** The latest list read sent; an older answer landing after it is dropped. */
	fetchSeq: Schema.Number,
})
export type SharingState = typeof SharingState.Type

export const initSharing = (): SharingState => ({
	shares: AsyncData.Idle(),
	origin: "",
	dialog: Dialog.init("dashboard-share-dialog", "dialog"),
	pendingAccess: null,
	isBusy: false,
	error: null,
	linkCopy: CopyButton.init(),
	replaceDialog: Dialog.init("dashboard-share-replace", "alert-dialog"),
	embedDialog: Dialog.init("dashboard-embed-dialog", "dialog"),
	embedWidgetId: null,
	embedTabs: Tabs.init({ idBase: 400, values: ["html", "react"], selected: "html" }),
	snippetCopy: CopyButton.init(),
	embedNowMs: 0,
	queuedChart: null,
	fetchSeq: 0,
})

export const ShareMessage = defineMessageUnion({
	CompletedFetchShares: { seq: Schema.Number, result: Schema.Result(Schema.Array(ShareRow), LoadFailure) },
	GotOrigin: { origin: Schema.String },
	GotDialogMessage: { message: Dialog.Message },
	GotAccessMessage: { message: RadioGroup.Message },
	ClickedReplace: {},
	GotReplaceDialogMessage: { message: Dialog.Message },
	ConfirmedReplace: {},
	CompletedWrite: { error: Schema.NullOr(Schema.String) },
	GotLinkCopyMessage: { message: CopyButton.Message },
	GotEmbedDialogMessage: { message: Dialog.Message },
	GotEmbedTabsMessage: { message: Tabs.Message },
	GotSnippetCopyMessage: { message: CopyButton.Message },
	ClickedMakePublic: {},
})
export type ShareMessage = typeof ShareMessage.Type

export const boardShareOf = (shares: ReadonlyArray<ShareRow>): ShareRow | undefined =>
	shares.find((share) => share.widgetId === null)

export const chartShareOf = (shares: ReadonlyArray<ShareRow>, widgetId: string): ShareRow | undefined =>
	shares.find((share) => share.widgetId === widgetId && share.mode === "public")

/** What a share link pins: the viewer's picked range (null for the board's saved one) and zone. */
export interface ShareLinkRange {
	readonly range: TimeRange | null
	readonly timeZone: string
}

/** The share page's `?range=` or `?from=&to=` for a viewer's picked range. */
const rangeParams = (range: TimeRange | null): Array<[string, string]> =>
	range === null
		? []
		: range.type === "relative"
			? [["range", range.value]]
			: [
					["from", range.startTime],
					["to", range.endTime],
				]

/**
 * `?tz=` so a zone-dependent range resolves on the sender's wall clock. A link without its own
 * range always carries it: the board's saved range can later change to one that needs it.
 */
const zoneParams = (link: ShareLinkRange): Array<[string, string]> =>
	link.range === null || (link.range.type === "relative" && isZoneDependentShorthand(link.range.value))
		? [["tz", link.timeZone]]
		: []

const linkParams = (link: ShareLinkRange): Array<[string, string]> => [
	...rangeParams(link.range),
	...zoneParams(link),
]

const withParams = (url: string, params: Array<[string, string]>): string =>
	params.length === 0 ? url : `${url}?${new URLSearchParams(params).toString()}`

/** A share link: with the viewer's own range, so the recipient sees the window they picked. */
export const shareUrl = (origin: string, token: string, link: ShareLinkRange): string =>
	withParams(`${origin}/share/${token}`, linkParams(link))

/** `?embed=true` drops the share page's own header, leaving only the chart. */
export const embedUrl = (origin: string, token: string, link: ShareLinkRange): string =>
	withParams(`${origin}/share/${token}`, [["embed", "true"], ...linkParams(link)])
