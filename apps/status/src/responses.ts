/** Edge-cacheable for 15s, served stale for a day if this Worker errors. */
export const PUBLIC_CACHE_CONTROL = "public, max-age=15, stale-while-revalidate=60, stale-if-error=86400"

const COMMON_HEADERS = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "strict-origin-when-cross-origin",
} as const

/** Inline style and script run only with this response's nonce; images may come from any https host. */
export const htmlCsp = (nonce: string): string =>
	[
		"default-src 'none'",
		`style-src 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
		"img-src https: data:",
		"form-action 'self'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
	].join("; ")

export const html = (
	body: string,
	init: { status?: number; cacheControl: string; nonce: string },
): Response =>
	new Response(body, {
		status: init.status ?? 200,
		headers: {
			...COMMON_HEADERS,
			"content-type": "text/html; charset=utf-8",
			"cache-control": init.cacheControl,
			"content-security-policy": htmlCsp(init.nonce),
		},
	})

export const asset = (body: string, contentType: string, extra: Record<string, string> = {}): Response =>
	new Response(body, {
		headers: {
			...COMMON_HEADERS,
			"content-type": contentType,
			"cache-control": PUBLIC_CACHE_CONTROL,
			"content-security-policy": "default-src 'none'",
			...extra,
		},
	})

export const plain = (body: string, status: number, cacheControl = "no-store"): Response =>
	new Response(body, {
		status,
		headers: {
			...COMMON_HEADERS,
			"content-type": "text/plain; charset=utf-8",
			"cache-control": cacheControl,
		},
	})

export const redirect = (location: string): Response =>
	new Response(null, { status: 303, headers: { ...COMMON_HEADERS, location, "cache-control": "no-store" } })

const NOT_FOUND_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status page not found</title></head><body><h1>Status page not found</h1><p>There is no status page at this address.</p></body></html>`

export const notFound = (): Response =>
	new Response(NOT_FOUND_HTML, {
		status: 404,
		headers: {
			...COMMON_HEADERS,
			"content-type": "text/html; charset=utf-8",
			"cache-control": "public, max-age=60",
			"content-security-policy": "default-src 'none'",
		},
	})
