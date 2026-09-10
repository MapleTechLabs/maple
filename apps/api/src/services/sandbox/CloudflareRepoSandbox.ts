/**
 * effect-agent's `Sandbox` port over Cloudflare's Sandbox container.
 *
 * The contract asks an implementation to enforce each requested feature or
 * reject it, so this one is explicit about its posture. It provides: an isolated
 * container, exactly one repository mount, a wall clock, an output bound, and
 * `NetworkDisabled` — enforced by running the command in a fresh network
 * namespace, and refused outright when the container cannot open one, so a
 * command that asked for no egress never runs with it. It does not provide: an
 * allowlist (it can only switch egress on or off), CPU or memory limits,
 * secrets, or artifacts.
 *
 * What the container does have, unlike the archive-based predecessor, is real
 * git history: the checkout is a full clone at the requested commit.
 */
import { OrgId } from "@maple/domain/http"
import {
	SANDBOX_COMMAND_ENV,
	SandboxCheckout,
	SandboxExecRequest,
	type SandboxExecResponse,
} from "@maple/domain/sandbox"
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
import { Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { SandboxClient } from "@/sandbox/client"
import { VcsSourceService, type RepositoryCheckout } from "@/services/integrations/vcs/VcsSourceService"
import { parseRepoMountSource, REPO_MOUNT_TARGET, REPO_SANDBOX_RUNTIME } from "./repo-mount"

export const IMPLEMENTATION = new SandboxImplementation({
	isolation: "isolated",
	identity: "cloudflare-sandbox",
})

const unsupported = (feature: SandboxUnsupportedRequestError["feature"], message: string) =>
	new SandboxUnsupportedRequestError({ implementation: IMPLEMENTATION, feature, message })

const decodeOrgId = Schema.decodeUnknownOption(OrgId)

interface AdmittedRequest {
	readonly orgId: OrgId
	readonly repository: string
	readonly ref: string | undefined
	/** Checkout-relative working directory. */
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
				"this sandbox can only switch egress off entirely; it cannot enforce a destination allowlist",
			)
		const unknownEnv = request.environment.allow.filter((name) => !(name in SANDBOX_COMMAND_ENV))
		if (unknownEnv.length > 0)
			return yield* unsupported(
				"runtime",
				`a command sees only ${Object.keys(SANDBOX_COMMAND_ENV).join(", ")}; it cannot be given ${unknownEnv.join(", ")}`,
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

/** The sandbox Worker's answer as the contract's events, or its failure. */
export const toEvents = (
	request: SandboxRequest,
	response: SandboxExecResponse,
): Effect.Effect<ReadonlyArray<SandboxEvent>, SandboxError> => {
	switch (response._tag) {
		case "SandboxExited": {
			const events: SandboxEvent[] = [
				new SandboxStarted({
					eventVersion: 1,
					implementation: IMPLEMENTATION,
					runtime: request.runtime,
				}),
			]
			if (response.stdoutBytes > 0)
				events.push(
					new SandboxOutput({
						eventVersion: 1,
						implementation: IMPLEMENTATION,
						stream: "stdout",
						text: response.stdout,
						bytes: response.stdoutBytes,
					}),
				)
			if (response.stderrBytes > 0)
				events.push(
					new SandboxOutput({
						eventVersion: 1,
						implementation: IMPLEMENTATION,
						stream: "stderr",
						text: response.stderr,
						bytes: response.stderrBytes,
					}),
				)
			events.push(
				new SandboxExited({
					eventVersion: 1,
					implementation: IMPLEMENTATION,
					exitCode: response.exitCode,
					resourceUse: new SandboxResourceUse({
						wallTime: Duration.millis(response.wallTimeMs),
						stdoutBytes: response.stdoutBytes,
						stderrBytes: response.stderrBytes,
					}),
					artifacts: [] as ReadonlyArray<SandboxArtifact>,
				}),
			)
			return Effect.succeed(events)
		}
		case "SandboxTimedOut":
			return Effect.fail(
				new SandboxTimeoutError({
					implementation: IMPLEMENTATION,
					maxWallTime: request.limits.maxWallTime,
				}),
			)
		case "SandboxOutputExceeded":
			return Effect.fail(
				new SandboxOutputLimitError({
					implementation: IMPLEMENTATION,
					stream: response.stream,
					limit: response.limit,
					observed: response.observed,
				}),
			)
		case "SandboxIsolationUnavailable":
			// Declared as unsupported rather than as a spawn failure: the container is
			// working, it simply cannot provide the network posture that was asked for.
			return Effect.fail(unsupported("network", response.message))
		case "SandboxCheckoutFailed":
			return Effect.fail(spawnError(request.command, response.message))
		case "SandboxUnavailable":
			return Effect.fail(
				new SandboxExitError({
					implementation: IMPLEMENTATION,
					exitCode: -1,
					message: response.message,
				}),
			)
	}
}

/** One Cloudflare sandbox per repository per organization; the org is in the key. */
export const sandboxKey = (orgId: OrgId, checkout: RepositoryCheckout): string =>
	`${orgId}:${checkout.provider}:${checkout.fullName.toLowerCase()}`

export interface CloudflareRepoSandboxDeps {
	readonly resolveCheckout: VcsSourceService["Service"]["resolveCheckout"]
	readonly exec: SandboxClient["Service"]["exec"]
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
				yield* Effect.annotateCurrentSpan({
					"vcs.repository.full_name": checkout.fullName,
					"vcs.ref.head.revision": checkout.sha,
					"maple.sandbox.command": request.command,
				})
				const answered = yield* deps
					.exec(
						new SandboxExecRequest({
							sandboxKey: sandboxKey(admitted.orgId, checkout),
							checkout: new SandboxCheckout({
								repository: checkout.fullName,
								sha: checkout.sha,
								cloneUrl: checkout.cloneUrl,
								remoteUrl: checkout.remoteUrl,
							}),
							command: request.command,
							args: request.args,
							cwd: admitted.cwd,
							network: "disabled",
							timeoutMs: Duration.toMillis(request.limits.maxWallTime),
							maxOutputBytes: request.limits.maxOutputBytes,
						}),
					)
					.pipe(Effect.mapError((error) => spawnError(request.command, error.message, error)))
				if (Option.isNone(answered))
					return yield* unsupported("runtime", "no repository sandbox is bound in this deployment")
				return Stream.fromIterable(yield* toEvents(request, answered.value))
			}),
		),
})

/** The port over the sandbox service binding and the org's connected repositories. */
export const CloudflareRepoSandboxLive: Layer.Layer<Sandbox, never, VcsSourceService | SandboxClient> =
	Layer.effect(
		Sandbox,
		Effect.gen(function* () {
			const source = yield* VcsSourceService
			const client = yield* SandboxClient
			return makeCloudflareRepoSandbox({ resolveCheckout: source.resolveCheckout, exec: client.exec })
		}),
	)
