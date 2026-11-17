import { StatusPageId } from "@maple/domain"
import { StatusPagePublicSnapshot } from "@maple/domain/status-page"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { PreviewScheme, PreviewState, PreviewWidth } from "../shared/preview"

// `/status-pages/$pageId/view`: the page as visitors would see it, read by a signed-in member.
// An internal page is served nowhere else.

export const Model = Schema.Struct({
	/** The URL segment as typed, for the not-found message. */
	rawPageId: Schema.String,
	/** `null` when the URL segment is not a page id. */
	pageId: Schema.NullOr(StatusPageId),
	snapshot: KeyedSchema(StatusPagePublicSnapshot, LoadFailure),
	/** The preview's own switches, as in the editor's Live page; none changes the page. */
	previewState: PreviewState,
	previewWidth: PreviewWidth,
	previewScheme: PreviewScheme,
})
export type Model = typeof Model.Type
