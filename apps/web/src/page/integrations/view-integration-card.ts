import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "@maple/views/ui/heading"
import type { Keyed } from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { button } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { itemActions, itemContent, mediaCard } from "@maple/views/ui/item"
import { skeletonBlock } from "@maple/views/ui/skeleton"
import { type IntegrationBrand, integrationIconPlate } from "../kit/integration-empty"
import { Message, type StatusName } from "./message"
import type { Model } from "./model"
import { disconnectDialog, type SharedDisconnect } from "./view-disconnect"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"

// The shell of a connected integration's card and its status-load states, shared by every provider.

type H = HtmlBuilder<Message>

export type ConnectedIntegrationCardOptions = Readonly<{
	/** Names the shared disconnect dialog the card renders; `null` when the card brings its own. */
	integration: SharedDisconnect | null
	brand: IntegrationBrand
	title: string
	/** Extra classes on the title (a mono account id, a long workspace name). */
	titleClassName?: string
	/** Beside the title; `null` leaves the title on its own. */
	badge: Html | null
	/** Lets the title row wrap when narrow (default true). */
	titleWraps?: boolean
	summary: ReadonlyArray<Html | string> | null
	/** The summary under the title: spaced by the content gap (default), `tight` or in a `stacked` column. */
	summaryLayout?: "spaced" | "tight" | "stacked"
	notice?: Html | null
	/** What the card shows between the summary and its actions. */
	body?: ReadonlyArray<Html>
	/** The action row, or what replaces it (Railway's token form). */
	actions: Html | null
	/** Puts the actions at the header's end instead of under the summary. */
	actionsAtEnd?: boolean
	/** What follows the actions (a panel they open). */
	afterActions?: ReadonlyArray<Html>
	/** The content column's gap class; `null` keeps the item's own. */
	contentGap?: string | null
	/** The resources table under the card. */
	table?: Html
	/** A note under the table. */
	footer?: Html
}>

const titleBlock = (h: H, options: ConnectedIntegrationCardOptions): ReadonlyArray<Html> => {
	const title = heading(h, { level: 3, variant: "section", className: options.titleClassName }, [
		options.title,
	])
	const row =
		options.badge === null
			? title
			: hstack(h, { gap: "2", wrap: options.titleWraps ?? true }, [title, options.badge])
	if (options.summary === null) return [row]
	switch (options.summaryLayout ?? "spaced") {
		case "spaced":
			return [row, typography(h, { size: "xs", tone: "muted", as: "p" }, options.summary)]
		case "tight":
			return [
				h.div(
					[],
					[
						row,
						typography(
							h,
							{ size: "xs", tone: "muted", as: "p", className: "mt-1" },
							options.summary,
						),
					],
				),
			]
		case "stacked":
			return [
				vstack(h, { gap: "1" }, [
					row,
					typography(h, { size: "xs", tone: "muted", as: "p" }, options.summary),
				]),
			]
	}
}

export const connectedIntegrationCard = (
	h: H,
	model: Model,
	options: ConnectedIntegrationCardOptions,
): Html => {
	const atEnd = options.actionsAtEnd === true
	const content = [
		...titleBlock(h, options),
		...(options.notice === undefined || options.notice === null ? [] : [options.notice]),
		...(options.body ?? []),
		...(atEnd || options.actions === null ? [] : [options.actions]),
		...(options.afterActions ?? []),
		...(options.integration === null ? [] : [disconnectDialog(h, model, options.integration)]),
	]
	const gap = options.contentGap === undefined ? "gap-2" : options.contentGap
	const card = mediaCard(h, integrationIconPlate(h, options.brand), [
		gap === null ? itemContent(h, content) : itemContent(h, content, gap),
		...(atEnd && options.actions !== null ? [itemActions(h, [options.actions])] : []),
	])
	return options.table === undefined && options.footer === undefined
		? card
		: vstack(h, { gap: "4" }, [
				card,
				...(options.table === undefined ? [] : [options.table]),
				...(options.footer === undefined ? [] : [options.footer]),
			])
}

/** Access is gone: says what stopped and how to resume. */
export const integrationAlertNotice = (h: H, text: string): Html =>
	typography(h, { size: "xs", tone: "destructive", as: "p", attributes: [h.Role("alert")] }, [text])

/** The last sync error, clamped to two lines with the full text on hover. */
export const integrationErrorNotice = (h: H, label: string, error: string): Html =>
	h.p(
		[h.Class("line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]"), h.Title(error)],
		[label, error],
	)

export const integrationActions = (h: H, buttons: ReadonlyArray<Html>): Html =>
	hstack(h, { gap: "2", align: "stretch", wrap: true }, buttons)

export const disconnectButton = (h: H, model: Model): Html =>
	button(
		h,
		{
			size: "sm",
			variant: "outline",
			isLoading: model.disconnect.isPending,
			attributes: [h.OnClick(Message.ClickedDisconnect())],
		},
		["Disconnect"],
	)

export type IntegrationStatusCardOptions<S> = Readonly<{
	name: StatusName
	failureTitle: string
	render: (status: S) => Html
	/** What shows while the read is idle or loading (a 32 high block by default). */
	loading?: () => Html
	/** Try again's message (the status re-read by default). */
	onRetry?: Message
	/** A failed refresh over shown data: keep `render`ing it (default), or show the failure. */
	stale?: "render" | "failure"
	/** Replaces the failure's error state. */
	failure?: () => Html
}>

/** A status read's card: a skeleton while loading, a retry on failure, else `render`. */
export const integrationStatusCard = <S>(
	h: H,
	status: Keyed<S, LoadFailure>,
	options: IntegrationStatusCardOptions<S>,
): Html => {
	const loading = options.loading ?? (() => skeletonBlock(h, { height: "32" }))
	const failed = (failure: LoadFailure) =>
		options.failure?.() ??
		errorState(h, {
			failure,
			title: options.failureTitle,
			onRetry: options.onRetry ?? Message.ClickedRetryStatus({ name: options.name }),
		})
	return AsyncData.match(status.data, {
		onIdle: loading,
		onLoading: loading,
		onFailure: failed,
		onStale: ({ data, error }) => (options.stale === "failure" ? failed(error) : options.render(data)),
		onRefreshing: (data) => options.render(data),
		onSuccess: (data) => options.render(data),
	})
}
