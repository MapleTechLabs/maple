import { Option } from "effect"
import { AsyncData } from "foldkit"
import { infraSurfacesOf } from "../../../data/infra-surfaces"
import type { NavSurface } from "../../../shell/nav"
import type { PageContext } from "../../contract"
import type { Model, SourceId, SourceSummary } from "./model"
import { SOURCE_IDS } from "./model"

// `SourceState` and `presentSources`.

export type SourceState =
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "ready"; readonly summary: SourceSummary }

export const sourceState = (model: Model, id: SourceId): SourceState =>
	AsyncData.matchData(model.sources[id].data, {
		onEmpty: (): SourceState => ({ status: "loading" }),
		onFailure: (): SourceState => ({ status: "error" }),
		onData: ({ summary }): SourceState =>
			summary === null ? { status: "error" } : { status: "ready", summary },
	})

const SOURCE_SURFACES = {
	hosts: ["hosts"],
	containers: ["containers"],
	kubernetes: ["k8sPods", "k8sNodes", "k8sWorkloads"],
	cloudflare: ["cloudflare"],
	railway: ["railway"],
	supabase: ["supabase"],
	planetscale: ["planetscale"],
	gcp: ["gcp"],
	aws: ["aws"],
} satisfies Readonly<{ [K in SourceId]: ReadonlyArray<NavSurface> }>

const NOT_CONNECTED = {
	cloudflare: false,
	railway: false,
	planetscale: false,
	gcp: false,
	supabase: false,
	aws: false,
}

/** `useInfraSurfaces(window)`: the page's probe (the last answer while a new window loads) and the shell's statuses. */
export const surfacesOf = (model: Model, context: PageContext): ReadonlySet<NavSurface> | null =>
	infraSurfacesOf(
		Option.getOrNull(AsyncData.getData(model.presence.data)),
		context.infra?.integrations ?? NOT_CONNECTED,
	)

/** The sources an org has. Unknown presence (`null`) shows every source rather than hiding one. */
export const presentSources = (surfaces: ReadonlySet<NavSurface> | null): ReadonlyArray<SourceId> =>
	surfaces === null
		? SOURCE_IDS
		: SOURCE_IDS.filter((id) => SOURCE_SURFACES[id].some((surface) => surfaces.has(surface)))
