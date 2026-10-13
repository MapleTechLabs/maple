/**
 * The deployed Worker's entry, as a plain module: every request goes to
 * `./handler`, the markdown-twin negotiation over the assets. `worker.ts`
 * declares the Worker and its build; this is what alchemy bundles.
 */
import { type AssetsBinding, handleRequest } from "./handler"

export default {
	fetch: (request: Request, env: { readonly ASSETS: AssetsBinding }): Promise<Response> =>
		handleRequest(request, env.ASSETS),
}
