import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { pageTitle } from "@maple/views/ui/page-layout"
import { statusDot } from "@maple/views/ui/status-dot"
import type { CatalogEntry } from "./catalog"
import { cardStatusOf, HEALTH_TONE, lastSyncText, overviewOf } from "./derive"
import { relativeTime } from "../kit/relative-time"
import { Message } from "./message"
import type { Model } from "./model"
import { entryPlate } from "./view-entry"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

type H = HtmlBuilder<Message>

export type HeaderSlots = Readonly<{
	/** Google Cloud's status line, replacing the default one while it is connected. */
	statusLine?: Html
	/** Controls before the Connect button (Cloudflare's). */
	actions?: ReadonlyArray<Html>
	/** The Connect button, shown while the integration is available. */
	connect?: Html
}>

export const integrationHeader = (
	h: H,
	model: Model,
	entry: CatalogEntry,
	slots: HeaderSlots,
	timeZone: string,
): Html => {
	const status = cardStatusOf(model.statuses, entry.id, model.nowMs)
	const overview = overviewOf(model.statuses, model.nowMs, entry.id)
	const connected = overview?.kind === "connected" ? overview : null
	const statusParts =
		connected === null
			? []
			: Arr.filter(
					[connected.stateLabel, connected.context],
					(part): part is string => part !== null && part !== "",
				)
	const lastSync = connected?.lastSync ?? null
	// The plain reading for the truncation title; the line itself carries a timestamp.
	const statusLine = Arr.join(
		lastSync === null ? statusParts : [...statusParts, lastSyncText(lastSync, model.nowMs)],
		" · ",
	)
	return hstack(h, { wrap: true, className: "gap-x-3 gap-y-2" }, [
		iconButton(
			h,
			{
				label: "Back to integrations",
				attributes: [h.OnClick(Message.ClickedIntegration({ integration: null }))],
			},
			[icon(h, "ArrowLeftIcon")],
		),
		entryPlate(h, entry, { size: 18, plateClassName: "size-9 rounded-lg" }),
		vstack(h, { gap: "0.5", shrink: true, grow: true }, [
			hstack(h, { gap: "2", shrink: true }, [
				pageTitle(h, { title: entry.name, className: "min-w-0" }, [entry.name]),
				...(connected === null && status !== null
					? [badge(h, { variant: status.variant }, [status.label])]
					: []),
			]),
			...(connected !== null && slots.statusLine !== undefined
				? [slots.statusLine]
				: connected !== null && statusLine !== ""
					? [
							hstack(h, { gap: "1.5" }, [
								statusDot(h, { tone: HEALTH_TONE[connected.health] }),
								typography(
									h,
									{
										size: "xs",
										tone: "muted",
										truncate: true,
										attributes: [h.Title(statusLine)],
									},
									[
										Arr.join(statusParts, " · "),
										...(lastSync === null
											? []
											: [
													statusParts.length === 0 ? "" : " · ",
													relativeTime(h, {
														value: lastSync.at,
														nowMs: model.nowMs,
														timeZone,
														prefix: lastSync.verb,
													}),
												]),
									],
								),
							]),
						]
					: []),
		]),
		hstack(
			h,
			{
				gap: "3",
				align: "center",
				justify: "end",
				className: "ml-auto shrink-0 basis-full sm:basis-auto",
			},
			[
				...(entry.docsUrl !== undefined
					? [
							h.a(
								[
									h.Href(entry.docsUrl),
									h.Target("_blank"),
									h.Rel("noreferrer"),
									h.Class(
										hstackClass({
											gap: "1",
											inline: true,
											className: typographyClass({
												size: "xs",
												tone: "muted",
												hoverTone: "foreground",
											}),
										}),
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
	])
}
