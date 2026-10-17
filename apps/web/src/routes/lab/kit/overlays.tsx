import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { KitOverlaysLab } from "@/lab/kit/overlays"

// `item` stays a plain string here: the route shell is in the startup bundle and `src/lab/`
// must not be, so the page narrows it against `OVERLAY_ITEMS` itself.
const kitOverlaysSearchSchema = Schema.Struct({
	item: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/lab/kit/overlays")({
	component: KitOverlaysPage,
	validateSearch: Schema.toStandardSchemaV1(kitOverlaysSearchSchema),
})

function KitOverlaysPage() {
	const { item } = Route.useSearch()
	// `key` remounts the page per item, so each overlay opens fresh from its `defaultOpen`.
	return <KitOverlaysLab key={item ?? "none"} item={item} />
}
