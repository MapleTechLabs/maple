import type { PushSourcePlatform } from "@maple/domain/primitives"
import { cardButton } from "../../../ui/card-button"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { statusDot } from "../../../ui/status-dot"
import { DATA_INTEGRATIONS, type DataIntegration } from "../../integrations/embed"
import { HEALTH_TONE, overviewOf } from "../../integrations/derive"
import { PLATFORMS, platformTile, PUSH_PLATFORMS, type PlatformMeta } from "../kit/platforms"
import { Message } from "./message"
import type { Model } from "./model"

// `PlatformPicker`: the Source step.

type H = HtmlBuilder<Message>

/** WarpStream is a Prometheus target with its own setup, so it has no source platform of its own. */
const WARPSTREAM: PlatformMeta = {
	label: "WarpStream",
	description: "Cluster metrics via Prometheus",
	icon: "WarpStreamIcon",
}

export const integrationMeta = (integration: DataIntegration): PlatformMeta =>
	integration === "warpstream" ? WARPSTREAM : PLATFORMS[integration]

const tile = (h: H, meta: PlatformMeta): Html =>
	h.span(
		[
			h.AriaHidden(true),
			h.Class("bg-card inline-flex size-10 shrink-0 items-center justify-center rounded-lg border"),
		],
		[icon(h, meta.icon, { size: 18 })],
	)

const card = (
	h: H,
	key: string,
	meta: PlatformMeta,
	leading: Html,
	onSelect: Message,
	badge: Html | null,
): Html =>
	cardButton(
		h,
		{ onClick: onSelect, className: "flex items-center gap-3 px-3 py-3", attributes: [h.Key(key)] },
		[
			leading,
			h.span(
				[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
				[
					h.span([h.Class("truncate text-sm font-medium")], [meta.label]),
					h.span(
						[h.Class("font-prose text-muted-foreground truncate text-xs")],
						[meta.description],
					),
				],
			),
			...(badge === null ? [] : [badge]),
			icon(h, "ChevronRightIcon", {
				size: 14,
				className: "text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
			}),
		],
	)

/** "Connected" on an integration that already feeds a source, toned by its health. */
const connectedBadge = (h: H, model: Model, integration: DataIntegration): Html | null => {
	const overview = overviewOf(model.integrations.statuses, model.integrations.nowMs, integration)
	if (overview?.kind !== "connected") return null
	return h.span(
		[
			h.Class(
				"inline-flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-2xs text-muted-foreground",
			),
		],
		[statusDot(h, { tone: HEALTH_TONE[overview.health] }), "Connected"],
	)
}

/** A titled group of cards, with how its sources reach Maple at the title's end. */
const section = (h: H, title: string, caption: string, cards: ReadonlyArray<Html>): Html =>
	h.section(
		[h.Class("flex flex-col gap-3")],
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1")],
				[
					eyebrow(h, { as: "h2" }, [title]),
					h.span([h.Class("text-xs text-muted-foreground")], [caption]),
				],
			),
			h.div([h.Class("grid gap-2 sm:grid-cols-2 xl:grid-cols-3")], cards),
		],
	)

/** Push platforms create a source here; integrations open their connect step. */
export const platformPicker = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex flex-col gap-8")],
		[
			section(
				h,
				"Send with OpenTelemetry",
				"Your code or agent pushes data to Maple with an ingest key",
				PUSH_PLATFORMS.map((platform: PushSourcePlatform) =>
					card(
						h,
						platform,
						PLATFORMS[platform],
						platformTile(h, platform),
						Message.ClickedPushPlatform({ platform }),
						null,
					),
				),
			),
			section(
				h,
				"Connect an integration",
				"Maple reads from your provider",
				DATA_INTEGRATIONS.map((integration) =>
					card(
						h,
						integration,
						integrationMeta(integration),
						tile(h, integrationMeta(integration)),
						Message.ClickedIntegration({ integration }),
						connectedBadge(h, model, integration),
					),
				),
			),
		],
	)
