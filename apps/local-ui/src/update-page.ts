import { AsyncData, Update } from "foldkit"
import { Option } from "effect"
import { FetchSignalPresence, GoBack, Navigate, ProbeServer, RememberRange } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { canGoBack } from "./navigation"
import { type Lane, stopSuperseded } from "./data/lanes"
import { ApplicationDefinition } from "./page/application-definition"
import { lanesOf, pageKeyOf } from "./page/page-model"
import { initPageStep, locationChangedStep, refreshPageStep } from "./page/registry"
import { openFilterDrawerStep, resetFilterDrawerStep } from "./shell/bindings"

const { makeStep, makeFieldsStep, makeCommandsStep } = ApplicationDefinition

/** `useSignalPresence` mounting: reuse the shared read unless it is loading or stale. */
const requestPresenceStep = makeStep((model: Model) => {
	if (AsyncData.isLoading(model.presence) || AsyncData.isRefreshing(model.presence)) return { model }
	const lastReadAtMs = model.isPresenceStale
		? null
		: Option.match(AsyncData.getData(model.presence), { onNone: () => null, onSome: (result) => result.nowMs })
	const presence = Option.getOrElse(AsyncData.revalidateOrLoad(model.presence), () => model.presence)
	return {
		model: { ...model, presence, isPresenceStale: false },
		commands: [FetchSignalPresence({ apiBase: model.env.apiBase, lastReadAtMs })],
	}
})

/** Start a probe now, retiring any pending timer. */
export const probeStep = makeStep((model: Model) =>
	model.probe.isInFlight
		? { model }
		: {
				model: { ...model, probe: { isInFlight: true, version: model.probe.version + 1 } },
				commands: [ProbeServer({ apiBase: model.env.apiBase })],
			},
)

/**
 * Stops the requests that were in flight before a page step (`before`) whose key no lane after
 * it still holds: chDB runs one query at a time.
 */
const stopSupersededStep = (before: ReadonlyArray<Lane>) =>
	makeCommandsStep((after: Model) =>
		stopSuperseded(before, lanesOf(after.page), (outcome) => Message.CompletedCancelPageFetch({ outcome })),
	)

/** A page asked the root for something only the root may do: one Step per PageOutMessage. */
export const pageOutHandlers = {
	RequestedNavigation: ({ hash, isReplace }: Readonly<{ hash: string; isReplace: boolean }>) =>
		makeStep((model: Model) => ({
			model: { ...model, isReplacing: isReplace },
			commands: [Navigate({ hash, isReplace })],
		})),
	RequestedBack: ({ fallbackHash }: Readonly<{ fallbackHash: string }>) =>
		makeCommandsStep((model: Model) =>
			canGoBack(model.visited) ? [GoBack()] : [Navigate({ hash: fallbackHash, isReplace: false })],
		),
	RememberedRange: ({ range, hash }: Readonly<{ range: string; hash: string }>) =>
		makeStep((model: Model) => ({
			model: { ...model, rememberedRange: range, isReplacing: true },
			commands: [RememberRange({ range }), Navigate({ hash, isReplace: true })],
		})),
	RequestedSignalPresence: () => requestPresenceStep,
	RefetchedInPlace: () =>
		Update.combineSteps([makeFieldsStep(() => ({ isPresenceStale: () => true })), probeStep]),
	RequestedFilterDrawer: () => openFilterDrawerStep,
}

/** A new route builds a new page (and a closed drawer); the same page sees the new fragment. */
export const enterLocationStep = (previousKey: string | null) =>
	makeStep((model: Model) => {
		const stopsStep = stopSupersededStep(lanesOf(model.page))
		return previousKey === pageKeyOf(model.route)
			? Update.combineSteps([locationChangedStep, stopsStep])
			: Update.combineSteps([resetFilterDrawerStep, initPageStep(model.route), stopsStep])
	})

/** The notice's Try again: probe now and refetch the open page (`refetchQueries(["local"])`). */
export const retryStaleDataStep = makeStep((model: Model) =>
	Update.combineSteps([probeStep, refreshPageStep, stopSupersededStep(lanesOf(model.page))]),
)
