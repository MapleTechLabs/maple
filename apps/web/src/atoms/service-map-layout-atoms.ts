import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

interface ServiceMapLayout {
	positions: Record<string, { x: number; y: number }>
	viewport: { x: number; y: number; zoom: number } | null
	/**
	 * The layout signature these positions were captured against (topology +
	 * namespace assignment + spacing config). Positions are only honoured while
	 * this still matches the live layout — when the graph shape or namespaces
	 * change, the stale absolute coordinates would scatter nodes out of their
	 * clusters and overlap the dotted namespace boxes, so they're discarded.
	 * Optional so pre-existing localStorage entries (no signature) decode and are
	 * treated as a mismatch.
	 */
	signature?: string
}

const Position = Schema.Struct({ x: Schema.Number, y: Schema.Number })
const Viewport = Schema.Struct({ x: Schema.Number, y: Schema.Number, zoom: Schema.Number })

const ServiceMapLayoutSchema = Schema.Struct({
	positions: Schema.Record(Schema.String, Position),
	viewport: Schema.NullOr(Viewport),
	signature: Schema.optionalKey(Schema.String),
}) as Schema.Codec<ServiceMapLayout>

const DEFAULT: ServiceMapLayout = { positions: {}, viewport: null }

export const serviceMapLayoutAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple.service-map.layout.${orgId}`,
		schema: ServiceMapLayoutSchema,
		defaultValue: () => DEFAULT,
	}),
)
