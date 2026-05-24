// Extract a useful message from a thrown / rejected value, falling back to a
// caller-supplied default. Used at every `Effect.tryPromise({ catch })` site
// that builds an error message from `unknown` cause data.
export const causeMessage = (cause: unknown, fallback: string): string =>
	cause instanceof Error ? cause.message : fallback

// GitHub REST API error responses are JSON-shaped `{ message, documentation_url? }`.
// When a 4xx/5xx body comes back, parse out the `message` so it surfaces in
// logs/traces instead of the raw response text (which often includes the full
// docs URL and other noise). Falls back to the raw text if parsing fails or
// the body isn't shaped as expected.
export const githubErrorMessage = (rawBody: string): string => {
	if (!rawBody) return rawBody
	try {
		const json = JSON.parse(rawBody) as { message?: unknown }
		if (typeof json.message === "string" && json.message.length > 0) return json.message
	} catch {
		// Not JSON — fall through to the raw body.
	}
	return rawBody
}
