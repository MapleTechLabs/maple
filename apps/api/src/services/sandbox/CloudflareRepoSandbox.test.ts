import { assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import {
	SandboxRunCheckoutFailed,
	SandboxRunCheckoutPending,
	SandboxRunExited,
	SandboxRunIsolationUnavailable,
	SandboxRunTimedOut,
	SandboxRunUnavailable,
	type SandboxExecRequest,
	type SandboxExecResponse,
} from "@maple/domain/sandbox"
import {
	NetworkAllowlist,
	SandboxArtifactRule,
	SandboxEnvironment,
	SandboxLimits,
	SandboxMount,
	SandboxRequest,
	SandboxRuntime,
	SandboxSecretHandle,
} from "@effect-agent/sandbox/Sandbox"
import { Duration, Effect, Exit, Option, Schema, Stream } from "effect"
import type { RepositoryCheckout } from "@/services/integrations/vcs/VcsSourceService"
import { admit, makeCloudflareRepoSandbox } from "./CloudflareRepoSandbox"
import { NETWORK_DISABLED, REPO_SANDBOX_RUNTIME, repoMount } from "./repo-mount"

const ORG = Schema.decodeUnknownSync(OrgId)("org_sandbox_test")
const SHA = "c".repeat(40)

const request = (overrides: Partial<ConstructorParameters<typeof SandboxRequest>[0]> = {}) =>
	new SandboxRequest({
		runtime: REPO_SANDBOX_RUNTIME,
		command: "git",
		args: ["grep", "-e", "boom"],
		cwd: "/workspace/src",
		environment: new SandboxEnvironment({ allow: ["PATH", "HOME", "LANG"] }),
		mounts: [repoMount({ orgId: ORG, repository: "octo/shop", ref: "main" })],
		network: NETWORK_DISABLED,
		limits: new SandboxLimits({ maxOutputBytes: 1024, maxWallTime: Duration.seconds(5) }),
		secretHandles: [],
		artifactRules: [],
		...overrides,
	})

const checkout: RepositoryCheckout = {
	provider: "github",
	fullName: "octo/shop",
	ref: "main",
	sha: SHA as RepositoryCheckout["sha"],
	remoteUrl: "https://github.test/octo/shop.git",
	token: "ghs_scoped",
}

/** The sandbox Worker as the port sees it: one call, one answer. `bound: false` is a deployment without one. */
const makeSandbox = (
	answer: (request: SandboxExecRequest) => SandboxExecResponse,
	calls: string[] = [],
	bound = true,
) =>
	makeCloudflareRepoSandbox({
		resolveCheckout: (orgId, repository, ref) => {
			calls.push(`checkout:${orgId}:${repository}:${ref}`)
			return Effect.succeed(checkout)
		},
		exec: (execRequest) => {
			if (!bound) return Effect.succeed(Option.none())
			calls.push(
				`exec:${execRequest.command} ${execRequest.args.join(" ")}|@${execRequest.cwd}|sha=${execRequest.checkout.sha}`,
			)
			return Effect.succeed(Option.some(answer(execRequest)))
		},
	})

const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>): string | undefined =>
	Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
		? exit.cause.reasons[0].error._tag
		: undefined

describe("admit", () => {
	it.effect("accepts the request shape the tools build", () =>
		Effect.gen(function* () {
			const admitted = yield* admit(request())
			assert.deepStrictEqual(admitted, { orgId: ORG, repository: "octo/shop", ref: "main", cwd: "src" })
		}),
	)

	it.effect("refuses every feature it cannot enforce, naming the feature", () =>
		Effect.gen(function* () {
			const cases: Array<[string, Parameters<typeof request>[0]]> = [
				["runtime", { runtime: new SandboxRuntime({ kind: "microvm", identity: "firecracker" }) }],
				// The container pins one environment, so a narrower allowlist is refused
				// rather than quietly answered with all three names.
				["runtime", { environment: new SandboxEnvironment({ allow: ["PATH"] }) }],
				[
					"runtime",
					{ environment: new SandboxEnvironment({ allow: ["PATH", "HOME", "LANG", "TERM"] }) },
				],
				// It can switch egress off entirely, but it cannot police destinations.
				["network", { network: new NetworkAllowlist({ domains: ["github.com"], ports: [443] }) }],
				[
					"cpu-limit",
					{
						limits: new SandboxLimits({
							cpuCores: 1,
							maxOutputBytes: 1024,
							maxWallTime: Duration.seconds(1),
						}),
					},
				],
				[
					"memory-limit",
					{
						limits: new SandboxLimits({
							memoryBytes: 1024,
							maxOutputBytes: 1024,
							maxWallTime: Duration.seconds(1),
						}),
					},
				],
				[
					"secret-handles",
					{ secretHandles: [new SandboxSecretHandle({ id: "gh", purpose: "clone" })] },
				],
				["artifacts", { artifactRules: [new SandboxArtifactRule({ path: "out", maxBytes: 10 })] }],
				["mounts", { mounts: [] }],
				[
					"mounts",
					{
						mounts: [
							new SandboxMount({
								source: "maple-vcs://org/octo/shop",
								target: "/workspace",
								access: "read-write",
							}),
						],
					},
				],
				[
					"mounts",
					{
						mounts: [
							new SandboxMount({
								source: "s3://bucket",
								target: "/workspace",
								access: "read-only",
							}),
						],
					},
				],
				["mounts", { cwd: "/tmp" }],
				["mounts", { cwd: "/workspace/../etc" }],
			]
			for (const [feature, overrides] of cases) {
				const exit = yield* Effect.exit(admit(request(overrides)))
				assert.isTrue(Exit.isFailure(exit), feature)
				if (Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail") {
					assert.strictEqual(
						exit.cause.reasons[0].error.feature,
						feature,
						JSON.stringify(overrides),
					)
				}
			}
		}),
	)
})

describe("the Cloudflare repository sandbox", () => {
	it.effect("resolves the checkout, runs the command with no egress, and reports the events", () =>
		Effect.gen(function* () {
			const calls: string[] = []
			const sandbox = makeSandbox(
				() =>
					new SandboxRunExited({
						exitCode: 1,
						stdout: "src/a.ts:1:boom",
						stderr: "",
						stdoutBytes: 15,
						stderrBytes: 0,
						stdoutTruncated: false,
						stderrTruncated: false,
						wallTimeMs: 40,
					}),
				calls,
			)
			const events = yield* Stream.runCollect(sandbox.execute(request()))
			assert.deepStrictEqual(
				events.map((event) => event._tag),
				["SandboxStarted", "SandboxOutput", "SandboxExited"],
			)
			assert.isTrue(events.every((event) => event.implementation.isolation === "isolated"))
			assert.deepStrictEqual(calls, [
				`checkout:${ORG}:octo/shop:main`,
				`exec:git grep -e boom|@src|sha=${SHA}`,
			])
		}),
	)

	it.effect("surfaces the container's bounds as the contract's failures", () =>
		Effect.gen(function* () {
			const timedOut = yield* Effect.exit(
				Stream.runCollect(
					makeSandbox(() => new SandboxRunTimedOut({ wallTimeMs: 5000 })).execute(request()),
				),
			)
			assert.strictEqual(failureTag(timedOut), "SandboxTimeoutError")

			const pending = yield* Effect.exit(
				Stream.runCollect(
					makeSandbox(() => new SandboxRunCheckoutPending({ message: "still preparing" })).execute(
						request(),
					),
				),
			)
			// A checkout that is not ready never started a process, so it must not
			// borrow the contract's "the process ran and exited" failure.
			assert.strictEqual(failureTag(pending), "SandboxSpawnError")

			const brokenCheckout = yield* Effect.exit(
				Stream.runCollect(
					makeSandbox(() => new SandboxRunCheckoutFailed({ message: "git clone failed" })).execute(
						request(),
					),
				),
			)
			assert.strictEqual(failureTag(brokenCheckout), "SandboxSpawnError")

			const gone = yield* Effect.exit(
				Stream.runCollect(
					makeSandbox(() => new SandboxRunUnavailable({ message: "no instance" })).execute(
						request(),
					),
				),
			)
			assert.strictEqual(failureTag(gone), "SandboxSpawnError")
		}),
	)

	it.effect("refuses rather than running with egress when the container cannot isolate the network", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				Stream.runCollect(
					makeSandbox(() => new SandboxRunIsolationUnavailable({ message: "no netns" })).execute(
						request(),
					),
				),
			)
			assert.strictEqual(failureTag(exit), "SandboxUnsupportedRequestError")
		}),
	)

	it.effect("reports a deployment without a sandbox worker as unsupported rather than crashing", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				Stream.runCollect(
					makeSandbox(() => new SandboxRunTimedOut({ wallTimeMs: 0 }), [], false).execute(
						request(),
					),
				),
			)
			assert.strictEqual(failureTag(exit), "SandboxUnsupportedRequestError")
		}),
	)
})
