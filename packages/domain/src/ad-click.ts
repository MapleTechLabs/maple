import { Schema } from "effect"

/**
 * The ad click a Google Ads link carries, shared by the landing cookie writer, the dashboard reader
 * and the API. The cookie value is `<type>.<id>.<clickTimeMs>`.
 */
export const AD_CLICK_COOKIE = "maple_ad_click"

/** `gclid` on most clicks, `gbraid`/`wbraid` from iOS. */
export const AD_CLICK_TYPES = ["gclid", "gbraid", "wbraid"] as const
export const AdClickType = Schema.Literals(AD_CLICK_TYPES)
export type AdClickType = typeof AdClickType.Type

export const AD_CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
export const AdClickId = Schema.String.check(Schema.isPattern(AD_CLICK_ID_PATTERN))
