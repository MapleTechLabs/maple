import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"
import {
	DEFAULT_SERVICE_MAP_VIEW_PREFS,
	type ServiceMapViewPrefs,
} from "@maple/ui/components/service-map/service-map-layout-state"

// Per-org declutter preferences; focus is navigational and lives in the URL instead.

const ServiceMapViewPrefsSchema = Schema.Struct({
	minTrafficPct: Schema.Number,
	collapsedNamespaces: Schema.Array(Schema.String),
}) as Schema.Codec<ServiceMapViewPrefs>

export const serviceMapViewPrefsAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple.service-map.view-prefs.${orgId}`,
		schema: ServiceMapViewPrefsSchema,
		defaultValue: () => DEFAULT_SERVICE_MAP_VIEW_PREFS,
	}),
)
