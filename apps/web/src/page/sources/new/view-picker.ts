import type { PushSourcePlatform } from "@maple/domain/primitives"
import { cardButton } from "@maple/views/ui/card-button"
import { revealIcon } from "@maple/views/ui/reveal-icon"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { statusDot } from "@maple/views/ui/status-dot"
import { DATA_INTEGRATIONS, type DataIntegration } from "../../integrations/embed"
import { HEALTH_TONE, overviewOf } from "../../integrations/derive"
import { PLATFORMS, platformTile, PUSH_PLATFORMS, type PlatformMeta } from "../kit/platforms"
import { Message } from "./message"
import type { Model } from "./model"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

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
			vstack(h, { gap: "0.5", shrink: true, grow: true, as: "span" }, [
				typography(h, { size: "sm", weight: "medium", truncate: true }, [meta.label]),
				typography(h, { size: "xs", tone: "muted", truncate: true, className: "font-prose" }, [
					meta.description,
				]),
			]),
			...(badge === null ? [] : [badge]),
			revealIcon(h, "ChevronRightIcon"),
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
	vstack(h, { gap: "3", as: "section" }, [
		hstack(h, { align: "baseline", justify: "between", wrap: true, className: "gap-x-4 gap-y-1" }, [
			eyebrow(h, { as: "h2" }, [title]),
			typography(h, { size: "xs", tone: "muted" }, [caption]),
		]),
		h.div([h.Class("grid gap-2 sm:grid-cols-2 xl:grid-cols-3")], cards),
	])

/** Push platforms create a source here; integrations open their connect step. */
export const platformPicker = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex flex-col gap-8")],
		[
			section(
				h,
				"Send with OpenTelemetry",
				"Your code or agent pushes data to Maple with an ingest key",
				Arr.map(PUSH_PLATFORMS, (platform: PushSourcePlatform) =>
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
				Arr.map(DATA_INTEGRATIONS, (integration) =>
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
