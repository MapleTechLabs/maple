import { useMemo } from "react"

import { DetectAiModelsRequest, type DetectAiModelResponse } from "@maple/domain/http"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { shortTarget } from "@/lib/agent-sessions/span-filters"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"

/**
 * What a model string resolved to, as the UI needs it. The same shape whether
 * the catalog answered or not: an unresolved model still has a name to print
 * (its last path segment, the best the client can do alone) and nulls that
 * `modelVendorIcon` reads as "no mark", so nothing branches on loading state.
 */
export interface DetectedModel {
	readonly model: string
	readonly displayName: string
	readonly vendorSlug: string | null
	readonly vendorName: string | null
	/** The vendor's brand color from the catalog, a light/dark pair. */
	readonly brandColor: DetectAiModelResponse["brandColor"]
	readonly family: string | null
}

const unresolved = (model: string): DetectedModel => ({
	model,
	displayName: shortTarget(model),
	vendorSlug: null,
	vendorName: null,
	brandColor: null,
	family: null,
})

/**
 * Detection is a pure catalog lookup — no org, no time window — that only
 * changes when the catalog is regenerated on a deploy, so the batch is keyed
 * by its models alone and the answer is held well past a navigation away.
 */
const detectionAtom = Atom.family((key: string) =>
	Atom.setIdleTTL(
		MapleInternalAtomClient.query("aiModelsInternal", "detectMany", {
			// Constructed, not a plain object: the payload is a `Schema.Class`, and
			// a structurally identical literal typechecks but fails to encode at
			// runtime — the request is never sent and the failure only shows up as
			// every model falling back to its raw id.
			// SAFETY: the key is this module's own `JSON.stringify` of a string
			// array, and the family is not reachable with any other key.
			payload: new DetectAiModelsRequest({ models: JSON.parse(key) as ReadonlyArray<string> }),
		}),
		"10 minutes",
	),
)

/** The endpoint's cap, mirrored so a long page degrades to unresolved names instead of a 400. */
const MAX_MODELS = 200

/**
 * Resolve a page's model strings to their vendor and display name in one
 * request. Returns a lookup rather than an array so callers can ask about a
 * model wherever they render it, in whatever order.
 */
export function useDetectedModels(models: ReadonlyArray<string>): (model: string) => DetectedModel {
	// One request per distinct set, so the sessions list re-asks only when
	// paging brings a model it has not seen. Sorted so two orders of the same
	// models share the key.
	const key = useMemo(() => JSON.stringify([...new Set(models)].sort().slice(0, MAX_MODELS)), [models])
	const result = useAtomValue(detectionAtom(key))

	return useMemo(() => {
		const detected = Result.builder(result)
			.onSuccess((value: ReadonlyArray<DetectAiModelResponse>) => value)
			.orElse(() => [] as ReadonlyArray<DetectAiModelResponse>)
		const byModel = new Map(detected.map((entry) => [entry.model, entry]))
		return (model: string) => byModel.get(model.trim()) ?? unresolved(model)
	}, [result])
}
