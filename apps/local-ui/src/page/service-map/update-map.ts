import type { SourceGraph } from "@maple/web/service-map/map/graph"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { type PageContext, PageOutMessage } from "../contract"
import { MapBinding } from "./composition"
import { ServiceMapPageDefinition } from "./definition"
import { durationSecondsOf, sourceGraphOf } from "./load"
import type { Model } from "./model"

const { makeStep, makeNoopStep } = ServiceMapPageDefinition

/** The graph of the rows on screen, once the rows and the stored state are both in. */
const sourceOf = (model: Model, context: PageContext): Option.Option<SourceGraph> =>
	Option.isNone(model.maybeStored)
		? Option.none()
		: Option.map(AsyncData.getData(model.data.data), (data) =>
				sourceGraphOf(data, durationSecondsOf(context)),
			)

/**
 * The graph follows the rows on screen (`buildFlowElements` every render in legacy): the first
 * time the rows and the stored state are both in, the map is created; later rows refine it.
 */
export const syncMapStep = (context: PageContext) =>
	makeStep((model: Model) =>
		Option.match(Option.all([sourceOf(model, context), model.maybeStored]), {
			onNone: () => makeNoopStep(),
			onSome: ([source, stored]) =>
				Option.isSome(model.maybeMap)
					? MapBinding.informOfSource({ source })
					: MapBinding.init({
							args: [
								source,
								{
									minTrafficPct: stored.prefs.minTrafficPct,
									collapsedNamespaces: stored.prefs.collapsedNamespaces,
									focus: Option.none(),
									snapshots: stored.snapshots,
									// local-ui's map frames itself on its first layout, namespace boxes or not.
									isFirstBoxedFitKept: true,
								},
							],
							toParentModel: (map) => ({ ...model, maybeMap: Option.some(map) }),
						}),
		}),
	)

/** An empty graph renders `SignalEmptyState`, which reads the shared signal presence. */
export const presenceAskOf = (model: Model, context: PageContext): PageOutMessage | undefined =>
	Option.exists(sourceOf(model, context), (source) => source.rawNodes.length === 0)
		? PageOutMessage.RequestedSignalPresence()
		: undefined
