/**
 * `verify:executor`'s stand-in for the registry gateway Worker: the real `gatewayFetch` on port 80,
 * reached as `registry.maple.internal`, with `git http-backend` on port 8081 standing in for GitHub.
 * npm requests go to the real public registry, so prepare's installs are real.
 *
 *   bun scripts/executor-gateway-stand-in.ts <dir holding fixture.git>
 *
 * Also `executor:local`'s gateway, with the audited clone's git directory mounted as fixture.git.
 */
import { spawn } from "node:child_process"
import { Effect, String as Str } from "effect"
import { gatewayFetch } from "../src/executor-gateway.ts"

const projectRoot = process.argv[2] ?? "/fixture"

/** One smart-HTTP request through `git http-backend`, a CGI program. */
const gitBackend = async (request: Request): Promise<Response> => {
	const url = new URL(request.url)
	const child = spawn("git", ["http-backend"], {
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			GIT_PROJECT_ROOT: projectRoot,
			GIT_HTTP_EXPORT_ALL: "1",
			PATH_INFO: url.pathname,
			QUERY_STRING: Str.slice(1)(url.search),
			REQUEST_METHOD: request.method,
			CONTENT_TYPE: request.headers.get("content-type") ?? "",
			HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
			HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
			REMOTE_ADDR: "127.0.0.1",
			// Prepare fetches one commit by its sha, as GitHub allows.
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "uploadpack.allowAnySHA1InWant",
			GIT_CONFIG_VALUE_0: "true",
		},
	})
	child.stdin.end(Buffer.from(await request.arrayBuffer()))
	const chunks: Array<Buffer> = []
	for await (const chunk of child.stdout) chunks.push(Buffer.from(chunk))
	const output = Buffer.concat(chunks)
	const split = output.indexOf("\r\n\r\n")
	const headers = new Headers()
	let status = 200
	for (const line of Str.split("\r\n")(output.subarray(0, split).toString())) {
		const at = line.indexOf(":")
		const name = Str.trim(Str.slice(0, at)(line))
		const value = Str.trim(Str.slice(at + 1)(line))
		if (Str.toLowerCase(name) === "status") status = Number.parseInt(value, 10)
		else headers.set(name, value)
	}
	return new Response(output.subarray(split + 4), { status, headers })
}

Bun.serve({ port: 8081, fetch: gitBackend })
Bun.serve({
	port: 80,
	fetch: (request) =>
		Effect.runPromise(
			gatewayFetch(
				request,
				{ git: { remoteUrl: "http://127.0.0.1:8081/fixture.git", token: "stand-in-token" } },
				(upstream) => fetch(upstream),
			),
		),
})
console.log("stand-in gateway ready")
