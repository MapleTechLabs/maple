import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Keyed } from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import { button } from "../../ui/button"
import { errorState } from "../../ui/error-state"
import { item, itemContent, itemMedia } from "../../ui/item"
import { skeleton } from "../../ui/skeleton"
import { type IntegrationBrand, integrationIconPlate } from "../infra-integrations/kit/integration-empty"
import { Message, type StatusName } from "./message"
import type { Model } from "./model"
import { disconnectDialog } from "./view-disconnect"

// The shell of a connected integration's card (Railway, Supabase) and its status-load states.

type H = HtmlBuilder<Message>

export type ConnectedIntegrationCardOptions = Readonly<{
	/** Also names the integration's disconnect dialog. */
	integration: StatusName
	brand: IntegrationBrand
	title: string
	badge: Html
	summary: ReadonlyArray<Html | string>
	notice: Html | null
	/** The action row, or what replaces it (Railway's token form). */
	actions: Html
	/** The resources table under the card. */
	table: Html
}>

export const connectedIntegrationCard = (
	h: H,
	model: Model,
	options: ConnectedIntegrationCardOptions,
): Html =>
	h.div(
		[h.Class("flex flex-col gap-4")],
		[
			item(h, { variant: "card", className: "items-start gap-4 p-4" }, [
				itemMedia(h, {}, [integrationIconPlate(h, options.brand)]),
				itemContent(
					h,
					[
						h.div(
							[h.Class("flex flex-wrap items-center gap-2")],
							[h.h3([h.Class("text-sm font-semibold")], [options.title]), options.badge],
						),
						h.p([h.Class("text-xs text-muted-foreground")], options.summary),
						...(options.notice === null ? [] : [options.notice]),
						options.actions,
						disconnectDialog(h, model, options.integration),
					],
					"gap-2",
				),
			]),
			options.table,
		],
	)

/** Access is gone: says what stopped and how to resume. */
export const integrationAlertNotice = (h: H, text: string): Html =>
	h.p([h.Class("text-xs text-severity-error"), h.Role("alert")], [text])

/** The last sync error, clamped to two lines with the full text on hover. */
export const integrationErrorNotice = (h: H, label: string, error: string): Html =>
	h.p(
		[h.Class("line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]"), h.Title(error)],
		[label, error],
	)

export const integrationActions = (h: H, buttons: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex flex-wrap gap-2")], buttons)

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

/** A status read's card: a skeleton while loading, a retry on failure, else `render`. */
export const integrationStatusCard = <S>(
	h: H,
	status: Keyed<S, LoadFailure>,
	options: Readonly<{ name: StatusName; failureTitle: string; render: (status: S) => Html }>,
): Html =>
	AsyncData.match(status.data, {
		onIdle: () => skeleton(h, "h-32 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-32 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: options.failureTitle,
				onRetry: Message.ClickedRetryStatus({ name: options.name }),
			}),
		onStale: ({ data }) => options.render(data),
		onRefreshing: (data) => options.render(data),
		onSuccess: (data) => options.render(data),
	})
