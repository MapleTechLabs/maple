import type { Resources } from "../../platform/resources"
import * as ServiceMap from "@maple/web/service-map/map/service-map"
import { Option } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { type PageContext, PageOutMessage } from "../contract"
import { SaveLayout, SaveViewPrefs } from "./command"
import { durationSecondsOf, sourceGraphOf } from "./load"
import { Message } from "./message"
import type { Model } from "./model"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PageOutMessage, Resources>

const toMap = (message: ServiceMap.Message) => Message.GotMapMessage({ message })

const merge = (first: UpdateReturn, next: UpdateReturn): UpdateReturn => ({
	model: next.model,
	commands: [...(first.commands ?? []), ...(next.commands ?? [])],
	outMessage: next.outMessage ?? first.outMessage,
})

/**
 * Folds a map step into the page; `onLayoutChange` / `onViewPrefsChange` write localStorage
 * whenever the map's drags, cameras or declutter prefs moved.
 */
export const withMapStep = (
	model: Model,
	step: Update.Return<ServiceMap.Model, ServiceMap.Message>,
): UpdateReturn => {
	const map = step.model
	const previous = Option.getOrUndefined(model.maybeMap)
	const isPrefsChanged =
		previous !== undefined &&
		(previous.minTrafficPct !== map.minTrafficPct ||
			previous.collapsedNamespaces !== map.collapsedNamespaces)
	const isLayoutChanged = previous !== undefined && previous.snapshots !== map.snapshots
	return {
		model: { ...model, maybeMap: Option.some(map) },
		commands: [
			...Command.mapMessages(step.commands ?? [], toMap),
			...(isPrefsChanged
				? [
						SaveViewPrefs({
							prefs: {
								minTrafficPct: map.minTrafficPct,
								collapsedNamespaces: map.collapsedNamespaces,
							},
						}),
					]
				: []),
			...(isLayoutChanged ? [SaveLayout({ snapshots: map.snapshots })] : []),
		],
	}
}

/**
 * The graph follows the rows on screen (`buildFlowElements` every render in legacy): the first
 * time the rows and the stored state are both in, the map is created; later rows refine it.
 */
export const syncMap = (result: UpdateReturn, context: PageContext): UpdateReturn => {
	const { model } = result
	const maybeData = AsyncData.getData(model.data.data)
	if (Option.isNone(maybeData) || Option.isNone(model.maybeStored)) return result
	const source = sourceGraphOf(maybeData.value, durationSecondsOf(context))
	const stored = model.maybeStored.value
	const step = Option.match(model.maybeMap, {
		onNone: () =>
			ServiceMap.init(source, {
				minTrafficPct: stored.prefs.minTrafficPct,
				collapsedNamespaces: stored.prefs.collapsedNamespaces,
				focus: Option.none(),
				snapshots: stored.snapshots,
				// local-ui's map frames itself on its first layout, namespace boxes or not.
				isFirstBoxedFitKept: true,
			}),
		onSome: (map) => ServiceMap.setSource(map, source),
	})
	const next = merge(result, withMapStep(model, step))
	// An empty graph renders `SignalEmptyState`, which reads the shared signal presence.
	return source.rawNodes.length === 0 && next.outMessage === undefined
		? { ...next, outMessage: PageOutMessage.RequestedSignalPresence() }
		: next
}
