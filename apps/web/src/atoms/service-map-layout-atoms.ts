import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"
import {
	EMPTY_SERVICE_MAP_LAYOUT,
	type ServiceMapLayout,
} from "@maple/ui/components/service-map/service-map-layout-state"

const Position = Schema.Struct({ x: Schema.Number, y: Schema.Number })
const Viewport = Schema.Struct({ x: Schema.Number, y: Schema.Number, zoom: Schema.Number })

const SnapshotSchema = Schema.Struct({
	signature: Schema.String,
	positions: Schema.Record(Schema.String, Position),
	viewport: Schema.NullOr(Viewport),
})

// Pre-snapshot localStorage entries ({positions, viewport, signature?}) fail to
// decode and fall back to the default — intentional: they were captured against
// the pre-ELK flat layout and would scatter nodes anyway.
const ServiceMapLayoutSchema = Schema.Struct({
	snapshots: Schema.Array(SnapshotSchema),
}) as Schema.Codec<ServiceMapLayout>

export const serviceMapLayoutAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple.service-map.layout.${orgId}`,
		schema: ServiceMapLayoutSchema,
		defaultValue: () => EMPTY_SERVICE_MAP_LAYOUT,
	}),
)
