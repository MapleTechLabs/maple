import { ATTRIBUTES, REGISTRY_VERSIONS, REMOVED_ATTRIBUTES } from "./generated/registry.ts"
import type { DeprecationReason, RegistryName } from "./types.ts"

export { REGISTRY_VERSIONS }

export interface AttributeDefinition {
	readonly id: string
	readonly registry: RegistryName
	readonly stability: string
	readonly type: string
	/** Set when the definition is deprecated; `successors` may be empty (obsoleted) or plural (split). */
	readonly deprecation?: {
		readonly reason: DeprecationReason
		readonly successors: ReadonlyArray<string>
	}
}

/**
 * What the registries say about one attribute key.
 *
 * - `current`: a live definition, directly or through a template such as
 *   `http.request.header.<key>`.
 * - `moved`: the semantic conventions deprecated it as "moved" while the GenAI
 *   registry defines it live under the same id. Current; nothing to change.
 * - `deprecated`: no live definition anywhere. `successors` names the
 *   replacement(s); empty means the key was obsoleted with none.
 * - `removed`: an earlier snapshot had it and the registry dropped it silently.
 * - `unknown`: in neither registry, e.g. a vendor or application key.
 */
export type AttributeStatus =
	| { readonly kind: "current"; readonly definition: AttributeDefinition }
	| { readonly kind: "moved"; readonly definition: AttributeDefinition }
	| {
			readonly kind: "deprecated"
			readonly definition: AttributeDefinition
			readonly successors: ReadonlyArray<string>
	  }
	| { readonly kind: "removed"; readonly registry: RegistryName; readonly lastSeenVersion: string }
	| { readonly kind: "unknown" }

const definitionsById = new Map<string, AttributeDefinition[]>()
const templates: AttributeDefinition[] = []
for (const [id, registry, stability, type, deprecation] of ATTRIBUTES) {
	const definition: AttributeDefinition = {
		id,
		registry,
		stability,
		type,
		...(deprecation
			? { deprecation: { reason: deprecation[0], successors: deprecation[1] } }
			: undefined),
	}
	const existing = definitionsById.get(id)
	if (existing) existing.push(definition)
	else definitionsById.set(id, [definition])
	if (type.startsWith("template[") && !deprecation) templates.push(definition)
}
// Longest prefix first, so `a.b.<key>` wins over `a.<key>`.
templates.sort((a, b) => b.id.length - a.id.length)

const removedById = new Map(
	REMOVED_ATTRIBUTES.map(([id, registry, lastSeenVersion]) => [id, { registry, lastSeenVersion }]),
)

/** Every definition of `key` across both registries, live ones first. */
export function definitions(key: string): ReadonlyArray<AttributeDefinition> {
	const found = definitionsById.get(key) ?? []
	return [...found].sort(
		(a, b) => Number(a.deprecation !== undefined) - Number(b.deprecation !== undefined),
	)
}

export function attributeStatus(key: string): AttributeStatus {
	const found = definitions(key)
	const live = found.find((d) => d.deprecation === undefined)
	if (live) {
		const movedStub = found.some((d) => d.deprecation !== undefined && d.registry !== live.registry)
		return { kind: movedStub ? "moved" : "current", definition: live }
	}
	// Checked before the deprecation: a "moved to GenAI" stub whose GenAI
	// definition was later dropped is gone, not merely deprecated.
	const removed = removedById.get(key)
	if (removed) return { kind: "removed", ...removed }
	const deprecated = found[0]
	if (deprecated?.deprecation) {
		return { kind: "deprecated", definition: deprecated, successors: deprecated.deprecation.successors }
	}
	const template = templates.find((t) => key.startsWith(`${t.id}.`))
	if (template) return { kind: "current", definition: template }
	return { kind: "unknown" }
}

/** True when either registry defines `key`, live or deprecated, directly or by template. */
export function isRegistryKey(key: string): boolean {
	const status = attributeStatus(key)
	return status.kind !== "unknown" && status.kind !== "removed"
}

/**
 * The live key `key` should be written as today. Follows single-successor
 * deprecations to the end of the chain; a key that is current, unknown,
 * obsoleted or split between several successors is returned unchanged.
 */
export function canonicalKey(key: string): string {
	let current = key
	const visited = new Set<string>()
	while (!visited.has(current)) {
		visited.add(current)
		const status = attributeStatus(current)
		if (status.kind !== "deprecated" || status.successors.length !== 1) return current
		const [next] = status.successors
		if (next === undefined) return current
		current = next
	}
	return current
}

let legacyIndex: Map<string, string[]> | undefined

/**
 * Every deprecated key whose {@link canonicalKey} is `key`, sorted. These are
 * the spellings a reader has to accept next to `key` for data from older
 * instrumentation.
 */
export function legacyKeys(key: string): ReadonlyArray<string> {
	if (!legacyIndex) {
		legacyIndex = new Map()
		for (const id of definitionsById.keys()) {
			const canonical = canonicalKey(id)
			if (canonical === id) continue
			const list = legacyIndex.get(canonical)
			if (list) list.push(id)
			else legacyIndex.set(canonical, [id])
		}
		for (const list of legacyIndex.values()) list.sort()
	}
	return legacyIndex.get(key) ?? []
}
