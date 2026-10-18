import { AsyncData } from "foldkit"
import type { Model, SourceId, SourceSummary } from "./model"
import { SOURCE_IDS } from "./model"

// `SourceState` and `presentSources` (components/infra/overview/infra-overview.tsx).

export type SourceState =
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "ready"; readonly summary: SourceSummary }

export const sourceState = (model: Model, id: SourceId): SourceState =>
	AsyncData.matchData(model.sources[id].data, {
		onEmpty: (): SourceState => ({ status: "loading" }),
		onFailure: (): SourceState => ({ status: "error" }),
		onData: ({ summary }): SourceState => (summary === null ? { status: "error" } : { status: "ready", summary }),
	})

/**
 * The sources an org has. Legacy reads the shell's presence probe and integration statuses, which
 * a page cannot reach yet: a source counts until its own read comes back empty (TODO: PageContext).
 */
export const presentSources = (model: Model): ReadonlyArray<SourceId> =>
	SOURCE_IDS.filter((id) =>
		AsyncData.matchData(model.sources[id].data, {
			onEmpty: () => true,
			onFailure: () => true,
			onData: ({ isReporting }) => isReporting,
		}),
	)
