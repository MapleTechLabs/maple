export type RegistryName = "semconv" | "genai"

export type DeprecationReason = "renamed" | "obsoleted" | "uncategorized"

/** `[id, registry, stability, type, deprecation]`; `deprecation` is `[reason, successors]`. */
export type GeneratedAttribute = readonly [
	id: string,
	registry: RegistryName,
	stability: string,
	type: string,
	deprecation: readonly [reason: DeprecationReason, successors: ReadonlyArray<string>] | null,
]

/** `[id, registry, lastSeenVersion]` for a key the registry dropped. */
export type GeneratedRemovedAttribute = readonly [id: string, registry: RegistryName, lastSeenVersion: string]
