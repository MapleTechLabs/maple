/**
 * The deployed local-mode dashboard's Worker entry, as a plain module. Static
 * assets come off the ASSETS binding; unknown routes fall back to the shell so
 * the client router can take over. `worker.ts` declares the Worker and its build.
 */
interface AssetsBinding {
	readonly fetch: (request: Request) => Promise<Response>
}

/**
 * This page can POST SQL to every visitor's loopback `maple start`, so an
 * injected script must not run. Vite emits only external module scripts; the
 * inline-style allowance covers the highlighted JSON views' `style` attributes.
 */
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self' data:",
	"connect-src 'self' http://127.0.0.1:* http://localhost:*",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ")

const SECURITY_HEADERS = {
	"content-security-policy": CONTENT_SECURITY_POLICY,
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"referrer-policy": "no-referrer",
	"cross-origin-opener-policy": "same-origin",
	"permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"strict-transport-security": "max-age=31536000",
} as const satisfies Readonly<Record<string, string>>

const withSecurityHeaders = (response: Response): Response => {
	// Asset responses can be immutable; copy before setting headers.
	const secured = new Response(response.body, response)
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value)
	return secured
}

const serve = async (request: Request, assets: AssetsBinding): Promise<Response> => {
	const asset = await assets.fetch(request)
	if (asset.status !== 404) return withSecurityHeaders(asset)
	// A fresh GET: the first fetch may have consumed the original request's body.
	return withSecurityHeaders(await assets.fetch(new Request(new URL("/index.html", request.url))))
}

export default {
	fetch: (request: Request, env: { readonly ASSETS: AssetsBinding }): Promise<Response> =>
		serve(request, env.ASSETS),
}
