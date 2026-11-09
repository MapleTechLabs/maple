import { Record as Rec } from "effect"

/**
 * Retired tool names, mapped to the tool that replaced them. Accepted on every surface and never
 * listed, so a client holding an old tool list keeps working. Its own module: the transport reads it
 * without loading the registry.
 */
export const TOOL_NAME_ALIASES = {
	list_sources: "list_ingest_sources",
} as const satisfies Readonly<Record<string, string>>

const ALIASES: ReadonlyMap<string, string> = new Map(Rec.toEntries(TOOL_NAME_ALIASES))

/** The registered name a call means. */
export const canonicalToolName = (name: string): string => ALIASES.get(name) ?? name
