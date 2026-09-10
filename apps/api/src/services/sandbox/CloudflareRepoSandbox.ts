/**
 * effect-agent's `Sandbox` port over Maple's repository containers.
 *
 * Every request is one command in one checkout. The contract asks an
 * implementation to enforce each requested feature or reject it, so this one is
 * explicit about its posture: isolated (a Cloudflare Container with internet
 * off), exactly one read-only repository mount, no CPU/memory limits, no
 * secrets, no artifacts. What it does enforce it enforces in the container:
 * the wall clock, the output bound, and the read-only tree.
 */
import { OrgId } from "@maple/domain/http"
import {
	Sandbox,
	SandboxArtifact,
	SandboxExited,
	SandboxExitError,
	SandboxImplementation,
	SandboxOutput,
	SandboxOutputLimitError,
	SandboxResourceUse,
	SandboxSpawnError,
	SandboxStarted,
	SandboxTimeoutError,
	SandboxUnsupportedRequestError,
	type SandboxError,
	type SandboxEvent,
	type SandboxRequest,
} from "@effect-agent/sandbox/Sandbox"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { callStub, repoSandboxKey, repoSandboxStub, type RepoSandboxStub } from "@/sandbox/namespace"
import { SAFE_ENVIRONMENT, type SandboxExecOutput } from "@/sandbox/protocol"
import { VcsSourceService, type RepositoryCheckout } from "@/services/integrations/vcs/VcsSourceService"
import { parseRepoMountSource, REPO_MOUNT_TARGET, REPO_SANDBOX_RUNTIME } from "./repo-mount"

export const IMPLEMENTATION = new SandboxImplementation({
	isolation: "isolated",
	identity: "maple-cloudflare-container",
})

const unsupported = (feature: SandboxUnsupportedRequestError["feature"], message: string) =>
	new SandboxUnsupportedRequestError({ implementation: IMPLEMENTATION, feature, message })

const decodeOrgId = Schema.decodeUnknownOption(OrgId)

interface AdmittedRequest {
	readonly orgId: OrgId
	readonly repository: string
	readonly ref: string | undefined
	/** Workspace-relative working directory. */
	readonly cwd: string
}

/** Everything the contract lets a request ask for that this implementation cannot honour, refused up front. */
export const admit = (
	request: SandboxRequest,
): Effect.Effect<AdmittedRequest, SandboxUnsupportedRequestError> =>
	Effect.gen(function* () {
		if (
			request.runtime.kind !== REPO_SANDBOX_RUNTIME.kind ||
			request.runtime.identity !== REPO_SANDBOX_RUNTIME.identity
		)
			return yield* unsupported(
				"runtime",
				`only the ${REPO_SANDBOX_RUNTIME.identity} container runtime is available`,
			)
		if (request.network._tag !== "NetworkDisabled")
			return yield* unsupported(
				"network",
				"the repository sandbox has no network; request NetworkDisabled",
			)
		if (request.limits.cpuCores !== undefined)
			return yield* unsupported("cpu-limit", "per-command CPU limits are not enforced")
		if (request.limits.memoryBytes !== undefined)
			return yield* unsupported("memory-limit", "per-command memory limits are not enforced")
		if (request.secretHandles.length > 0)
			return yield* unsupported("secret-handles", "the repository sandbox takes no secrets")
		if (request.artifactRules.length > 0)
			return yield* unsupported("artifacts", "the repository sandbox releases no artifacts")
		const mount = request.mounts[0]
		if (request.mounts.length !== 1 || mount === undefined)
			return yield* unsupported("mounts", "exactly one repository mount is required")
		if (mount.access !== "read-only")
			return yield* unsupported("mounts", "repository mounts are read-only")
		if (mount.target !== REPO_MOUNT_TARGET)
			return yield* unsupported("mounts", `repository mounts land at ${REPO_MOUNT_TARGET}`)
		const parsed = parseRepoMountSource(mount.source)
		if (Option.isNone(parsed))
			return yield* unsupported(
				"mounts",
				"mount source must be maple-vcs://<orgId>/<owner>/<name>[@ref]",
			)
		const orgId = decodeOrgId(parsed.value.orgId)
		if (Option.isNone(orgId)) return yield* unsupported("mounts", "mount source names no organization")
		if (request.cwd !== REPO_MOUNT_TARGET && !request.cwd.startsWith(`${REPO_MOUNT_TARGET}/`))
			return yield* unsupported("mounts", `cwd must be inside ${REPO_MOUNT_TARGET}`)
		const cwd = request.cwd === REPO_MOUNT_TARGET ? "." : request.cwd.slice(REPO_MOUNT_TARGET.length + 1)
		if (cwd.split("/").includes(".."))
			return yield* unsupported("mounts", "cwd must stay inside the mount")
		return { orgId: orgId.value, repository: parsed.value.repository, ref: parsed.value.ref, cwd }
	})

const spawnError = (command: string, message: string, cause?: unknown) =>
	new SandboxSpawnError({
		implementation: IMPLEMENTATION,
		command,
		message: message.slice(0, 8 * 1024),
		...(cause === undefined ? undefined : { cause }),
	})

/** The container's answer as the contract's events, or its failure. */
export const toEvents = (
	request: SandboxRequest,
	output: SandboxExecOutput,
): Effect.Effect<ReadonlyArray<SandboxEvent>, SandboxError> => {
	switch (output._tag) {
		case "exited": {
			const events: SandboxEvent[] = [
				new SandboxStarted({
					eventVersion: 1,
					implementation: IMPLEMENTATION,
					runtime: request.runtime,
				}),
			]
			if (output.stdoutBytes > 0)
				events.push(
					new SandboxOutput({
						eventVersion: 1,
						implementation: IMPLEMENTATION,
						stream: "stdout",
						text: output.stdout,
						bytes: output.stdoutBytes,
					}),
				)
			if (output.stderrBytes > 0)
				events.push(
					new SandboxOutput({
						eventVersion: 1,
						implementation: IMPLEMENTATION,
						stream: "stderr",
						text: output.stderr,
						bytes: output.stderrBytes,
					}),
				)
			events.push(
				new SandboxExited({
					eventVersion: 1,
					implementation: IMPLEMENTATION,
					exitCode: output.exitCode,
					resourceUse: new SandboxResourceUse({
						wallTime: Duration.millis(output.wallTimeMs),
						stdoutBytes: output.stdoutBytes,
						stderrBytes: output.stderrBytes,
					}),
					artifacts: [] as ReadonlyArray<SandboxArtifact>,
				}),
			)
			return Effect.succeed(events)
		}
		case "timed-out":
			return Effect.fail(
				new SandboxTimeoutError({
					implementation: IMPLEMENTATION,
					maxWallTime: request.limits.maxWallTime,
				}),
			)
		case "output-limit":
			return Effect.fail(
				new SandboxOutputLimitError({
					implementation: IMPLEMENTATION,
					stream: output.stream,
					limit: output.limit,
					observed: output.observed,
				}),
			)
		case "spawn-failed":
			return Effect.fail(spawnError(request.command, output.message))
		case "missing-workspace":
			return Effect.fail(
				new SandboxExitError({
					implementation: IMPLEMENTATION,
					exitCode: -1,
					message: `checkout ${output.sha} is not in the sandbox`,
				}),
			)
	}
}

export interface CloudflareRepoSandboxDeps {
	readonly resolveCheckout: VcsSourceService["Service"]["resolveCheckout"]
	readonly stubFor: (orgId: OrgId, checkout: RepositoryCheckout) => RepoSandboxStub | undefined
}

export const makeCloudflareRepoSandbox = (deps: CloudflareRepoSandboxDeps): Sandbox["Service"] => ({
	execute: (request) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const admitted = yield* admit(request)
				const checkout = yield* deps
					.resolveCheckout(admitted.orgId, admitted.repository, admitted.ref)
					.pipe(
						Effect.mapError((error) =>
							spawnError(request.command, `${error._tag}: ${error.message}`, error),
						),
					)
				const stub = deps.stubFor(admitted.orgId, checkout)
				if (stub === undefined)
					return yield* unsupported("runtime", "no repository sandbox is bound in this deployment")
				yield* Effect.annotateCurrentSpan({
					"vcs.repository.full_name": checkout.fullName,
					"vcs.ref.head.revision": checkout.sha,
					"maple.sandbox.command": request.command,
				})
				const workspace = yield* callStub(() =>
					stub.ensureWorkspace({ sha: checkout.sha, archiveUrl: checkout.archiveUrl }),
				).pipe(Effect.mapError((error) => spawnError(request.command, error.message, error)))
				if (workspace._tag === "archive-unavailable")
					return yield* spawnError(
						request.command,
						`the repository archive answered ${workspace.status}`,
					)
				if (workspace._tag === "restore-failed")
					return yield* spawnError(
						request.command,
						`restoring the checkout failed: ${workspace.message}`,
					)
				const output = yield* callStub(() =>
					stub.exec({
						sha: checkout.sha,
						command: request.command,
						args: request.args,
						cwd: admitted.cwd,
						envAllow: request.environment.allow.filter((name) =>
							(SAFE_ENVIRONMENT as ReadonlyArray<string>).includes(name),
						),
						maxOutputBytes: request.limits.maxOutputBytes,
						maxWallTimeMs: Duration.toMillis(request.limits.maxWallTime),
					}),
				).pipe(Effect.mapError((error) => spawnError(request.command, error.message, error)))
				return Stream.fromIterable(yield* toEvents(request, output))
			}),
		),
})

/** The port over the Worker's own `RepoSandbox` binding and the org's connected repositories. */
export const CloudflareRepoSandboxLive: Layer.Layer<Sandbox, never, VcsSourceService | WorkerEnvironment> =
	Layer.effect(
		Sandbox,
		Effect.gen(function* () {
			const source = yield* VcsSourceService
			const env = yield* WorkerEnvironment
			return makeCloudflareRepoSandbox({
				resolveCheckout: source.resolveCheckout,
				stubFor: (orgId, checkout) =>
					repoSandboxStub(env, repoSandboxKey(orgId, checkout.provider, checkout.fullName)),
			})
		}),
	)
