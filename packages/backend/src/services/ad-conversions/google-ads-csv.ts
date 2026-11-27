import type { AdClickType, AdConversionName } from "@maple/db/tables"
import { Array as Arr, DateTime, String as Str } from "effect"

/**
 * Google Ads click conversion import, as fetched by a scheduled HTTPS upload.
 * Format: https://support.google.com/google-ads/answer/7014069
 */

/** The conversion action names in Google Ads; they must match exactly. */
export const GOOGLE_ADS_CONVERSION_NAMES = {
	signup: "Sign-up (server)",
	activated: "Activated (server)",
} as const satisfies Record<AdConversionName, string>

export interface ExportableConversion {
	readonly conversion: AdConversionName
	readonly clickType: AdClickType
	readonly clickId: string
	readonly convertedAt: number
}

const HEADER = "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency"

/** `yyyy-MM-dd HH:mm:ss+0000`, one of the template's accepted forms, always in UTC. */
export const formatConversionTime = (epochMs: number): string =>
	`${Str.replace("T", " ")(Str.slice(0, 19)(DateTime.formatIso(DateTime.makeUnsafe(epochMs))))}+0000`

/**
 * The CSV body. File imports take only `gclid`, so `gbraid`/`wbraid` rows are left out. Value and
 * currency stay blank, so each action's default value applies.
 */
export const buildGoogleAdsConversionsCsv = (rows: ReadonlyArray<ExportableConversion>): string => {
	// Click ids are stored only after matching [A-Za-z0-9_-], so no field needs quoting.
	const lines = Arr.flatMap(rows, (row) =>
		row.clickType === "gclid"
			? [
					`${row.clickId},${GOOGLE_ADS_CONVERSION_NAMES[row.conversion]},${formatConversionTime(row.convertedAt)},,`,
				]
			: [],
	)
	return `${Arr.join(["Parameters:TimeZone=+0000", HEADER, ...lines], "\n")}\n`
}
