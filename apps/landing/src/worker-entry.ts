/**
 * The deployed Worker's entry, as a plain module: every request goes to
 * `./handler`, the markdown-twin negotiation over the assets, and a page opened from an ad link
 * keeps its click id (`./ad-click`). `worker.ts` declares the Worker and its build; this is what
 * alchemy bundles.
 */
import { withAdClickCookie } from "./ad-click"
import { type AssetsBinding, handleRequest } from "./handler"

/** Cloudflare's request metadata; only the visitor's country is read. */
type CloudflareRequest = Request & { readonly cf?: { readonly country?: string } }

export default {
	fetch: async (request: CloudflareRequest, env: { readonly ASSETS: AssetsBinding }): Promise<Response> =>
		withAdClickCookie(request, await handleRequest(request, env.ASSETS), request.cf?.country, Date.now()),
}
