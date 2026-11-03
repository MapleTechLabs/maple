/**
 * The registry gateway: what the executor's container reaches at `registry.maple.internal`, the
 * only host it can reach at all (internet off, this one host intercepted). Prepare fetches the
 * commit and the dependencies through it; Execute's network namespace cannot reach it.
 *
 * It answers exactly three things: the repository's git smart-HTTP fetch (`/git`, the credential
 * added here so the container never holds it, and never `git-receive-pack`), the public npm
 * registry read-only (`/npm/`), and the probe's marker. Everything else is refused.
 */
import { Effect } from "effect"
import { GATEWAY_HOST, GATEWAY_MARKER } from "./executor-probe"

export interface GatewayProps {
	/** The repository prepare fetches; absent for the probe. */
	readonly git?: { readonly remoteUrl: string; readonly token: string }
}

export const NPM_UPSTREAM = "https://registry.npmjs.org/"
const NPM_THROUGH_GATEWAY = `http://${GATEWAY_HOST}/npm/`

/** Response caps: a pack or tarball past these is not a dependency install. */
const MAX_GIT_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_GIT_REQUEST_BYTES = 4 * 1024 * 1024
const MAX_NPM_TARBALL_BYTES = 512 * 1024 * 1024
const MAX_NPM_METADATA_BYTES = 64 * 1024 * 1024

const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "content-encoding", "git-protocol"]
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"]

export type Upstream = (request: Request) => Promise<Response>

const attempt = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
	})

const refuse = (status: number, why: string) =>
	new Response(`${GATEWAY_MARKER}: ${why}\n`, { status, headers: { "content-type": "text/plain" } })

/** Cuts a body off past `limit` bytes, failing the stream so the client sees an error, not a short file. */
const capped = (body: ReadableStream<Uint8Array> | null, limit: number) => {
	if (body === null) return null
	let seen = 0
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.byteLength
				if (seen > limit) controller.error(new RangeError(`response exceeds ${limit} bytes`))
				else controller.enqueue(chunk)
			},
		}),
	)
}

const forwardHeaders = (from: Headers, names: ReadonlyArray<string>) => {
	const headers = new Headers()
	for (const name of names) {
		const value = from.get(name)
		if (value !== null) headers.set(name, value)
	}
	return headers
}

interface Route {
	readonly url: string
	readonly method: "GET" | "HEAD" | "POST"
	readonly authorization?: string
	readonly responseLimit: number
	/** npm metadata names tarballs by absolute registry URL; they are pointed back at the gateway. */
	readonly rewriteRegistryUrls: boolean
}

const basicToken = (token: string) => `Basic ${btoa(`x-access-token:${token}`)}`

/** Where an allowed request goes, or why it is refused. */
export const route = (request: Request, props: GatewayProps): Route | { readonly refused: string } => {
	const url = new URL(request.url)
	const method = request.method
	if (url.pathname.startsWith("/git/")) {
		const git = props.git
		if (git === undefined) return { refused: "no repository is being prepared" }
		const remote = git.remoteUrl.replace(/\/+$/u, "")
		if (
			method === "GET" &&
			url.pathname === "/git/info/refs" &&
			url.search === "?service=git-upload-pack"
		)
			return {
				url: `${remote}/info/refs?service=git-upload-pack`,
				method,
				authorization: basicToken(git.token),
				responseLimit: MAX_GIT_RESPONSE_BYTES,
				rewriteRegistryUrls: false,
			}
		if (method === "POST" && url.pathname === "/git/git-upload-pack" && url.search === "")
			return {
				url: `${remote}/git-upload-pack`,
				method,
				authorization: basicToken(git.token),
				responseLimit: MAX_GIT_RESPONSE_BYTES,
				rewriteRegistryUrls: false,
			}
		return { refused: `${method} ${url.pathname} is not a git fetch` }
	}
	if (url.pathname.startsWith("/npm/")) {
		if (method !== "GET" && method !== "HEAD") return { refused: "the npm registry is read-only" }
		const rest = url.pathname.slice("/npm/".length)
		if (rest === "" || rest.split("/").some((part) => part === "" || part === "." || part === ".."))
			return { refused: "not a package path" }
		const tarball = rest.endsWith(".tgz")
		return {
			url: `${NPM_UPSTREAM}${rest}`,
			method,
			responseLimit: tarball ? MAX_NPM_TARBALL_BYTES : MAX_NPM_METADATA_BYTES,
			rewriteRegistryUrls: !tarball,
		}
	}
	return { refused: `${method} ${url.pathname} is not allowed` }
}

/** One gateway request. Failures of the upstream become a 502 the package manager reports. */
export const gatewayFetch = (
	request: Request,
	props: GatewayProps,
	upstream: Upstream,
): Effect.Effect<Response> =>
	Effect.gen(function* () {
		const url = new URL(request.url)
		if (url.pathname === "/probe")
			return new Response(`${GATEWAY_MARKER} ${request.method} ${url.host}${url.pathname}`)
		const target = route(request, props)
		if ("refused" in target) {
			yield* Effect.logWarning("executor gateway refused a request").pipe(
				Effect.annotateLogs({
					"maple.executor.gateway.method": request.method,
					"maple.executor.gateway.path": url.pathname.slice(0, 200),
					"maple.executor.gateway.reason": target.refused,
				}),
			)
			return refuse(403, target.refused)
		}
		const headers = forwardHeaders(request.headers, FORWARDED_REQUEST_HEADERS)
		headers.set("user-agent", "maple-executor-gateway")
		if (target.authorization !== undefined) headers.set("authorization", target.authorization)
		// Buffered under its cap: a git negotiation is small, and a streamed body is not portable.
		const body =
			target.method === "POST"
				? yield* attempt(() =>
						new Response(capped(request.body, MAX_GIT_REQUEST_BYTES)).arrayBuffer(),
					)
				: null
		const response = yield* attempt(() =>
			upstream(new Request(target.url, { method: target.method, headers, body, redirect: "follow" })),
		)
		const responseHeaders = forwardHeaders(response.headers, FORWARDED_RESPONSE_HEADERS)
		const json = (response.headers.get("content-type") ?? "").includes("json")
		if (target.rewriteRegistryUrls && json && response.ok) {
			const length = Number(response.headers.get("content-length") ?? "0")
			if (length > MAX_NPM_METADATA_BYTES) return refuse(502, "package metadata is too large")
			// Capped while it streams: a missing or understated content-length cannot get it buffered whole.
			const text = yield* attempt(() =>
				new Response(capped(response.body, MAX_NPM_METADATA_BYTES)).text(),
			)
			return new Response(text.replaceAll(NPM_UPSTREAM, NPM_THROUGH_GATEWAY), {
				status: response.status,
				headers: responseHeaders,
			})
		}
		return new Response(capped(response.body, target.responseLimit), {
			status: response.status,
			headers: responseHeaders,
		})
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning("executor gateway upstream failed").pipe(
				Effect.annotateLogs({ "error.message": error.slice(0, 300) }),
				Effect.as(refuse(502, "the upstream did not answer")),
			),
		),
	)
