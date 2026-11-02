/**
 * `verify:executor`'s stand-in for the registry gateway Worker: the real `gatewayFetch` on port 80,
 * reached as `registry.maple.internal`, with `git http-backend` on port 8081 standing in for GitHub.
 * npm requests go to the real public registry, so prepare's installs are real.
 *
 *   bun scripts/executor-gateway-stand-in.ts <dir holding fixture.git>
 */
import { spawn } from "node:child_process"
import { Effect } from "effect"
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
			QUERY_STRING: url.search.slice(1),
			REQUEST_METHOD: request.method,
			CONTENT_TYPE: request.headers.get("content-type") ?? "",
			HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
			HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
			REMOTE_ADDR: "127.0.0.1",
		},
	})
	child.stdin.end(Buffer.from(await request.arrayBuffer()))
	const chunks: Array<Buffer> = []
	for await (const chunk of child.stdout) chunks.push(Buffer.from(chunk))
	const output = Buffer.concat(chunks)
	const split = output.indexOf("\r\n\r\n")
	const headers = new Headers()
	let status = 200
	for (const line of output.subarray(0, split).toString().split("\r\n")) {
		const at = line.indexOf(":")
		const name = line.slice(0, at).trim()
		const value = line.slice(at + 1).trim()
		if (name.toLowerCase() === "status") status = Number.parseInt(value, 10)
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
