import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../ui/display"
import { icon } from "../../ui/icon"
import { iconButton } from "../../ui/icon-button"
import { pageTitle } from "../../ui/page-layout"
import { statusDot } from "../../ui/status-dot"
import { catalogEntry, type IntegrationId } from "./catalog"
import { cardStatusOf, HEALTH_TONE, overviewOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { entryPlate } from "./view-entry"

// `IntegrationHeader`.

type H = HtmlBuilder<Message>

export type HeaderSlots = Readonly<{
	/** `GcpHeaderStatus`, replacing the status line while Google Cloud is connected. */
	statusLine?: Html
	/** Controls before the Connect button (`CloudflareHeaderActions`). */
	actions?: ReadonlyArray<Html>
	/** `useIntegrationConnect()`'s header button, shown while the integration is available. */
	connect?: Html
}>

export const integrationHeader = (
	h: H,
	model: Model,
	integration: IntegrationId,
	slots: HeaderSlots,
): Html => {
	const entry = catalogEntry(integration)
	const status = cardStatusOf(model.statuses, integration, model.nowMs)
	const overview = overviewOf(model.statuses, model.nowMs, integration)
	const connected = overview?.kind === "connected" ? overview : null
	const statusLine =
		connected === null
			? null
			: [connected.stateLabel, connected.context, connected.lastSyncLabel]
					.filter((part): part is string => part !== null && part !== "")
					.join(" · ")
	return h.div(
		[h.Class("flex flex-wrap items-center gap-x-3 gap-y-2")],
		[
			iconButton(
				h,
				{
					label: "Back to integrations",
					attributes: [h.OnClick(Message.ClickedIntegration({ integration: null }))],
				},
				[icon(h, "ArrowLeftIcon")],
			),
			entryPlate(h, entry, { size: 18, plateClassName: "size-9 rounded-lg" }),
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							pageTitle(h, { title: entry.name, className: "min-w-0" }, [entry.name]),
							...(connected === null && status !== null
								? [badge(h, { variant: status.variant }, [status.label])]
								: []),
						],
					),
					...(connected !== null && slots.statusLine !== undefined
						? [slots.statusLine]
						: connected !== null && statusLine !== null && statusLine !== ""
							? [
									h.div(
										[h.Class("flex items-center gap-1.5")],
										[
											statusDot(h, { tone: HEALTH_TONE[connected.health] }),
											h.span(
												[
													h.Class("truncate text-xs text-muted-foreground"),
													h.Title(statusLine),
												],
												[statusLine],
											),
										],
									),
								]
							: []),
				],
			),
			h.div(
				[h.Class("ml-auto flex shrink-0 basis-full items-center justify-end gap-3 sm:basis-auto")],
				[
					...(entry.docsUrl !== undefined
						? [
								h.a(
									[
										h.Href(entry.docsUrl),
										h.Target("_blank"),
										h.Rel("noreferrer"),
										h.Class(
											"inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground active:text-foreground",
										),
									],
									["Docs", icon(h, "ExternalLinkIcon", { size: 12 })],
								),
							]
						: []),
					...(connected !== null ? (slots.actions ?? []) : []),
					...(overview?.kind === "available" && slots.connect !== undefined ? [slots.connect] : []),
				],
			),
		],
	)
}
