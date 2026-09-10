/**
 * The `RepoSandbox` container's program and image. Bundled by alchemy into the
 * image (`main: import.meta.url`); never imported by a Worker. Reached only from
 * the root stack, which provides the layer this exports.
 */
import { parseMapleStage } from "@maple/infra/cloudflare"
import * as Dockerfile from "alchemy/Docker/Dockerfile"
import { Stage } from "alchemy/Stage"
import { Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { SANDBOX_USER, WORKSPACE_ROOT } from "./protocol"
import { RepoSandbox } from "./RepoSandbox"
import { isCommitSha, makeSandboxRuntime, type SandboxRuntime } from "./runtime/exec"

/**
 * `runuser` (util-linux) drops to the unprivileged user per command; `tar`
 * restores archives; `ripgrep` and `mawk` back the search and read tools.
 */
const image = Dockerfile.inline`
FROM oven/bun:1
USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates ripgrep tar gzip util-linux mawk \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd --system --no-create-home --shell /usr/sbin/nologin ${SANDBOX_USER} \
	&& mkdir -p ${WORKSPACE_ROOT} && chmod 755 ${WORKSPACE_ROOT}
`

const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const stage = parseMapleStage(yield* Stage)
	const production = stage.kind === "prd"
	return {
		main: import.meta.url,
		runtime: "bun" as const,
		dockerfile: image,
		// One live container per warm repository. Idle ones sleep and cost nothing.
		instanceType: production || stage.kind === "stg" ? ("basic" as const) : ("dev" as const),
		maxInstances: production ? 20 : stage.kind === "stg" ? 5 : 2,
		observability: { logs: { enabled: true } },
	}
})

const WORKSPACES = /^\/workspaces\/([0-9a-f]{40})$/

/** `PUT /workspaces/<sha>` with a gzipped tarball body restores a checkout; anything else is a health answer. */
const archiveServer = (runtime: SandboxRuntime) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const match = WORKSPACES.exec(new URL(request.url, "http://container").pathname)
		if (request.method !== "PUT" || match === null || !isCommitSha(match[1]!)) {
			return HttpServerResponse.text("maple repo sandbox", { status: 200 })
		}
		return yield* runtime.restoreArchive(match[1]!, request.stream).pipe(
			Effect.flatMap((restored) => HttpServerResponse.json(restored, { status: 201 })),
			Effect.catchTag("@maple/api/sandbox/RestoreError", (error) =>
				Effect.succeed(HttpServerResponse.text(error.message, { status: 500 })),
			),
		)
	})

export default RepoSandbox.make(
	props,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner
		const fs = yield* FileSystem
		const runtime = makeSandboxRuntime({
			spawner,
			fs,
			root: WORKSPACE_ROOT,
			runAs: SANDBOX_USER,
			environment: process.env,
		})
		return RepoSandbox.of({
			fetch: archiveServer(runtime),
			listWorkspaces: runtime.listWorkspaces,
			removeWorkspace: runtime.removeWorkspace,
			exec: runtime.exec,
		})
	}),
)
