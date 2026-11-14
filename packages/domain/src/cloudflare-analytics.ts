import { Option, Schema } from "effect"

const decodeSettings = Schema.decodeUnknownOption(
	Schema.fromJsonString(
		Schema.Struct({
			enabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
			maxDuration: Schema.optionalKey(Schema.NullOr(Schema.Number)),
		}),
	),
)

/** Only an explicit upstream capability denial is unavailable; absent/malformed settings stay unknown. */
export const cloudflareDatasetUnavailable = (settingsJson: string | null | undefined): boolean =>
	settingsJson == null
		? false
		: Option.match(decodeSettings(settingsJson), {
				onNone: () => false,
				onSome: (settings) => settings.enabled === false || settings.maxDuration === 0,
			})
