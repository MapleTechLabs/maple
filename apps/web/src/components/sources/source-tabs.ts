// Kept apart from source-detail: the route's search schema reads it, and anything the
// schema imports lands in the startup bundle.
export const SOURCE_TABS = ["overview", "setup", "settings"] as const
export type SourceTab = (typeof SOURCE_TABS)[number]
