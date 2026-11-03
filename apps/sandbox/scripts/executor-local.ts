/**
 * The execution sandbox on this machine, for `security:local --executor` and the eval: the same
 * wire as the sandbox Worker (`/internal/executor/{prepare,run,destroy}`), answered by the same
 * session code (`executor-session.ts`) over Docker containers of the deployed image instead of
 * Cloudflare's. Each executor sits on an internal network where only the stand-in gateway answers,
 * serving the audited clone's commits and the public npm registry.
 *
 *   bun run --cwd apps/sandbox executor:local <repo-dir> [--port 8790]
 *
 * Needs Docker and internet (for npm). Ctrl-C removes every container it started.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { resolve } from "node:path"
import {
	EXECUTOR_DESTROY_PATH,
	EXECUTOR_PREPARE_PATH,
	EXECUTOR_RUN_PATH,
	ExecutorDestroyRequest,
	ExecutorDestroyResponse,
	ExecutorPrepareRequest,
	ExecutorPrepareResponse,
	ExecutorRunRequest,
	ExecutorRunResponse,
} from "@maple/domain/executor"
import { Effect, Schema, Semaphore, String as Str } from "effect"
import { GATEWAY_HOST } from "../src/executor-probe.ts"
import { type ExecResult, type ExecutorHost, destroy, prepare, run } from "../src/executor-session.ts"

const args = process.argv.slice(2)
const repoDir = args.find((arg) => !Str.startsWith("--")(arg))
const portAt = args.indexOf("--port")
const port = portAt === -1 ? 8790 : Number(args[portAt + 1])
if (repoDir === undefined) {
	console.error("usage: bun run executor:local <repo-dir> [--port 8790]")
	process.exit(1)
}

const IMAGE = "maple-sandbox:executor"
const PREFIX = `maple-executor-local-${process.pid}`
const NETWORK = `${PREFIX}-internal`
const GATEWAY = `${PREFIX}-gateway`
const REPO_ROOT = resolve(import.meta.dirname, "../../..")
const gitDir = Str.trim(
	execFileSync("git", ["-C", resolve(repoDir), "rev-parse", "--path-format=absolute", "--git-common-dir"], {
		encoding: "utf8",
	}),
)

const docker = (dockerArgs: ReadonlyArray<string>) => spawnSync("docker", dockerArgs, { encoding: "utf8" })

const containers = new Set<string>()
const cleanup = () => {
	docker(["rm", "--force", GATEWAY, ...containers])
	docker(["network", "rm", NETWORK])
}
process.on("SIGINT", () => {
	cleanup()
	process.exit(0)
})

/** `docker exec` as the Durable Object's `exec()`: a root bash, its output, its exit code. */
const dockerExec = (container: string, script: string, timeoutMs: number, detach = false) =>
	Effect.callback<ExecResult, string>((resume) => {
		const started = Date.now()
		const child = spawn("docker", [
			"exec",
			...(detach ? ["--detach"] : []),
			container,
			"bash",
			"-c",
			script,
		])
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (chunk) => (stdout += chunk))
		child.stderr.on("data", (chunk) => (stderr += chunk))
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
		child.on("error", (error) => resume(Effect.fail(error.message)))
		child.on("close", (code) => {
			clearTimeout(timer)
			resume(Effect.succeed({ exitCode: code ?? -1, stdout, stderr, durationMs: Date.now() - started }))
		})
	})

const host = (key: string): ExecutorHost => {
	const name = `${PREFIX}-${key}`
	const running = () =>
		Str.trim(docker(["inspect", "--format", "{{.State.Running}}", name]).stdout) === "true"
	return {
		isRunning: running,
		ensureStarted: () =>
			Effect.suspend(() => {
				if (running()) return Effect.void
				containers.add(name)
				docker(["rm", "--force", name])
				const started = docker([
					"run",
					"--detach",
					"--name",
					name,
					"--network",
					NETWORK,
					"--privileged",
					IMAGE,
				])
				return started.status === 0 ? Effect.void : Effect.fail(Str.trim(started.stderr))
			}),
		exec: (script, timeoutMs) => dockerExec(name, script, timeoutMs),
		spawn: (script) => dockerExec(name, script, 30_000, true).pipe(Effect.asVoid),
		destroy: Effect.sync(() => {
			docker(["rm", "--force", name])
			containers.delete(name)
		}),
	}
}

const json = (body: unknown) =>
	new Response(encodeJson(body), { headers: { "content-type": "application/json" } })
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const commands = Semaphore.makeUnsafe(3)

/** One request: decoded with the wire schema, answered by the session, encoded back. */
const answer = (path: string, body: unknown): Effect.Effect<Response> => {
	const invalid = (error: unknown) => Effect.succeed(new Response(String(error), { status: 400 }))
	switch (path) {
		case EXECUTOR_PREPARE_PATH:
			return Schema.decodeUnknownEffect(ExecutorPrepareRequest)(body).pipe(
				Effect.flatMap((request) => prepare(host(request.executorKey), request)),
				Effect.map((response) => json(Schema.encodeSync(ExecutorPrepareResponse)(response))),
				Effect.catch(invalid),
			)
		case EXECUTOR_RUN_PATH:
			return Schema.decodeUnknownEffect(ExecutorRunRequest)(body).pipe(
				Effect.flatMap((request) =>
					commands.withPermits(1)(run(host(request.executorKey), request, crypto.randomUUID())),
				),
				Effect.map((response) => json(Schema.encodeSync(ExecutorRunResponse)(response))),
				Effect.catch(invalid),
			)
		case EXECUTOR_DESTROY_PATH:
			return Schema.decodeUnknownEffect(ExecutorDestroyRequest)(body).pipe(
				Effect.flatMap((request) => destroy(host(request.executorKey))),
				Effect.map((response) => json(Schema.encodeSync(ExecutorDestroyResponse)(response))),
				Effect.catch(invalid),
			)
		default:
			return Effect.succeed(new Response("Not found", { status: 404 }))
	}
}

execFileSync("docker", ["build", "--quiet", "--tag", IMAGE, `${import.meta.dirname}/../image`], {
	stdio: ["ignore", "ignore", "inherit"],
})
docker(["network", "create", "--internal", NETWORK])
execFileSync(
	"docker",
	[
		"run",
		"--detach",
		"--name",
		GATEWAY,
		"--volume",
		`${REPO_ROOT}:${REPO_ROOT}:ro`,
		"--volume",
		`${gitDir}:/fixture/fixture.git:ro`,
		"--entrypoint",
		"bun",
		IMAGE,
		`${REPO_ROOT}/apps/sandbox/scripts/executor-gateway-stand-in.ts`,
		"/fixture",
	],
	{ stdio: "ignore" },
)
execFileSync("docker", ["network", "connect", "--alias", GATEWAY_HOST, NETWORK, GATEWAY], { stdio: "ignore" })

Bun.serve({
	port,
	idleTimeout: 0,
	fetch: async (request) =>
		request.method === "POST"
			? Effect.runPromise(answer(new URL(request.url).pathname, await request.json()))
			: new Response("Not found", { status: 404 }),
})
console.log(`executor:local serving ${repoDir} on http://127.0.0.1:${port}`)
