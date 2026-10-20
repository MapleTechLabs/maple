import { WEB_ANALYTICS_UNSET } from "@maple/domain/query-engine"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../ui/icon"
import { browserIconFor, deviceIconFor } from "../replays/kit/sessions-parts"
import { Message, type FilterKey } from "./message"
import type { Model } from "./model"

// `Favicon` and `analyticsRowIcon`: a breakdown row's leading icon.

type H = HtmlBuilder<Message>

const ICON_BOX = "size-4 shrink-0"

const faviconUrl = (host: string): string => `https://favicon.maple.dev/?url=${encodeURIComponent(host)}`

/** `isHostLike`: a dotted name a favicon could exist for. */
export const isHostLike = (value: string): boolean => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)

/** `Favicon`: the site's icon, or its reserved box once the image failed. */
export const favicon = (h: H, model: Model, host: string, className?: string): Html =>
	model.failedFavicons.includes(host)
		? h.span([h.Class(cn(ICON_BOX, className)), h.AriaHidden(true)], [])
		: h.img([
				h.Src(faviconUrl(host)),
				h.Alt(""),
				h.AriaHidden(true),
				h.Loading("lazy"),
				h.Decoding("async"),
				h.Referrerpolicy("no-referrer"),
				h.OnError(Message.FailedFavicon({ host })),
				h.Class(cn(ICON_BOX, "rounded-[3px] object-contain", className)),
			])

const ICON_KEYS: ReadonlyArray<FilterKey> = ["referrerHost", "host", "utmSource", "browserName", "deviceType"]

export const dimensionHasIcons = (key: FilterKey): boolean => ICON_KEYS.includes(key)

export const analyticsRowIcon = (h: H, model: Model, key: FilterKey, name: string): Html | undefined => {
	switch (key) {
		case "referrerHost":
			return name === WEB_ANALYTICS_UNSET
				? icon(h, "ArrowThroughLineRightIcon", { className: cn(ICON_BOX, "text-foreground") })
				: favicon(h, model, name)
		case "host":
			return favicon(h, model, name)
		case "utmSource":
			return isHostLike(name) ? favicon(h, model, name) : undefined
		case "browserName":
			return icon(h, browserIconFor(name), { className: ICON_BOX })
		case "deviceType":
			return icon(h, deviceIconFor(name), { className: cn(ICON_BOX, "text-muted-foreground") })
		default:
			return undefined
	}
}
