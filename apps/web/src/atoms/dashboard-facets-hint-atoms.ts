import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

/**
 * Per-org hint persisted from a prior successful facets load, used to fire the
 * dashboard's downstream queries optimistically (in parallel with the facets
 * call) instead of waiting for facets to resolve first. See `routes/index.tsx`.
 */
export interface DashboardFacetsHint {
	/**
	 * The environment the dashboard defaults to filtering by — "production" when
	 * that environment exists, otherwise `null` (all environments). Independent of
	 * any explicit `?environment=` URL choice, which is transient.
	 */
	environment: string | null
	/** The default time preset ("6h" for all-demo orgs, else "24h"). */
	preset: string
	/**
	 * Whether this hint was derived from a successful facets load. Until it is, we
	 * have no basis to fetch optimistically, so the dashboard keeps its original
	 * facets gate. Distinguishes a never-seen org from a legitimate
	 * `environment: null` (an org with no "production" environment).
	 */
	seen: boolean
}

const DashboardFacetsHintSchema = Schema.Struct({
	environment: Schema.NullOr(Schema.String),
	preset: Schema.String,
	seen: Schema.Boolean,
}) as Schema.Codec<DashboardFacetsHint>

const DEFAULT: DashboardFacetsHint = { environment: null, preset: "24h", seen: false }

export const dashboardFacetsHintAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple.dashboard.facets-hint.${orgId}`,
		schema: DashboardFacetsHintSchema,
		defaultValue: () => DEFAULT,
	}),
)
