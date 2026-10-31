import { V2UptimeMonitor } from "@maple/domain/http/v2"
import { StatusPageThemeAppearance, StatusPageThemePreset } from "@maple/domain/status-page"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { Picker } from "../shared/picker"
import { PreviewHistory, PreviewScheme } from "../shared/preview"

// `/status-pages/new`: a page's name, address, components and look on one screen, beside the
// page as visitors will get it.

/** Publish makes the page public at once; a draft stays private until published. */
export const SubmitMode = Schema.Literals(["publish", "draft"])
export type SubmitMode = typeof SubmitMode.Type

export const Model = Schema.Struct({
	nowMs: Schema.NullOr(Schema.Number),
	isAdmin: Schema.Boolean,
	isSessionLoaded: Schema.Boolean,
	monitors: KeyedSchema(Schema.Array(V2UptimeMonitor), LoadFailure),
	/** The checklist is seeded from the first monitors read, then belongs to the user. */
	isSeeded: Schema.Boolean,
	name: Schema.String,
	slug: Schema.String,
	/** The user typed an address; until then it follows the name. */
	isSlugEdited: Schema.Boolean,
	isNameTouched: Schema.Boolean,
	picker: Picker,
	preset: StatusPageThemePreset,
	appearance: StatusPageThemeAppearance,
	previewScheme: PreviewScheme,
	/** Bumped on every edit; a debounce or a preview answer from an older one is stale. */
	previewGeneration: Schema.Number,
	/** The generation the shown history came from. */
	previewShown: Schema.Number,
	previewHistory: PreviewHistory,
	isPreviewLoading: Schema.Boolean,
	previewFailure: Schema.NullOr(LoadFailure),
	submitting: Schema.NullOr(SubmitMode),
	createFailure: Schema.NullOr(LoadFailure),
	/** An address the server refused as taken; it blocks publishing until changed. */
	takenSlug: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type
