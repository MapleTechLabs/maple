// OpenTelemetry semantic-conventions registry lookups: which attribute keys are
// current, which are deprecated and what replaced them, across the main
// registry and the separate GenAI registry. Data only, no runtime dependencies.

export {
	REGISTRY_VERSIONS,
	attributeStatus,
	canonicalKey,
	definitions,
	isRegistryKey,
	legacyKeys,
	type AttributeDefinition,
	type AttributeStatus,
} from "./registry.ts"
export type { DeprecationReason, RegistryName } from "./types.ts"
