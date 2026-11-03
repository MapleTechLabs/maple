import { WEB_ANALYTICS_UNSET } from "@maple/domain/query-engine"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { browserIconFor, deviceIconFor } from "../replays/kit/sessions-parts"
import { favicon as kitFavicon, isHostLike } from "../kit/analytics-filter-rail"
import { Message, type FilterKey } from "./message"
import type { Model } from "./model"

// `Favicon` and `analyticsRowIcon`: a breakdown row's leading icon.

type H = HtmlBuilder<Message>

const ICON_BOX = "size-4 shrink-0"

/** `Favicon`: the site's icon, or its reserved box once the image failed. */
export const favicon = (h: H, model: Model, host: string, className?: string): Html =>
	kitFavicon(
		h,
		{ failed: model.failedFavicons, onFailed: (failed) => Message.FailedFavicon({ host: failed }) },
		host,
		className,
	)

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
