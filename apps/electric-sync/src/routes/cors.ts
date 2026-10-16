/** CORS policy for the shape proxy. Every browser request carries a bearer, so every one is preflighted. */
export const ELECTRIC_SYNC_CORS_OPTIONS = {
	allowedOrigins: ["*"],
	allowedMethods: ["GET", "OPTIONS"],
	// The Fetch spec excludes `Authorization` from the `*` wildcard, so it must be listed.
	allowedHeaders: ["*", "Authorization"],
	// Required: without them the Electric client stalls after the first chunk.
	exposedHeaders: [
		"electric-handle",
		"electric-offset",
		"electric-schema",
		"electric-cursor",
		"electric-up-to-date",
	],
	// Same as the API. Without it Chrome holds a preflight for 5s. The cache is per URL, so
	// it only helps when a client repeats a shape URL (an unchanged live poll, a reload).
	maxAge: 86_400,
}
