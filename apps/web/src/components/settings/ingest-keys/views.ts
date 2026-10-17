// Dependency-free: the settings route's search schema imports this into the startup bundle.
export const ingestionViews = ["setup", "keys", "mappings"] as const
export type IngestionView = (typeof ingestionViews)[number]
