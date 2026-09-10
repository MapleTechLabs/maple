import { assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import {
	NetworkAllowlist,
	SandboxEnvironment,
	SandboxLimits,
	SandboxMount,
	SandboxRequest,
	SandboxRuntime,
	SandboxSecretHandle,
	SandboxArtifactRule,
} from "@effect-agent/sandbox/Sandbox"
import { Duration, Effect, Exit, Schema, Stream } from "effect"
import type { RepoSandboxStub } from "@/sandbox/namespace"
import type { EnsureWorkspaceInput, SandboxExecInput, SandboxExecOutput } from "@/sandbox/protocol"
import type { RepositoryCheckout } from "@/services/integrations/vcs/VcsSourceService"
import { admit, makeCloudflareRepoSandbox } from "./CloudflareRepoSandbox"
import { NETWORK_DISABLED, REPO_SANDBOX_RUNTIME, repoMount } from "./repo-mount"

const ORG = Schema.decodeUnknownSync(OrgId)("org_sandbox_test")
const SHA = "c".repeat(40)

const request = (overrides: Partial<ConstructorParameters<typeof SandboxRequest>[0]> = {}) =>
	new SandboxRequest({
		runtime: REPO_SANDBOX_RUNTIME,
		command: "rg",
		args: ["--", "."],
		cwd: "/workspace/src",
		environment: new SandboxEnvironment({ allow: ["PATH", "SECRET"] }),
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
	archiveUrl: "https://codeload.test/octo/shop/tar.gz/" + SHA,
}

const makeSandbox = (exec: (input: SandboxExecInput) => SandboxExecOutput, calls: string[] = []) => {
	const stub: RepoSandboxStub = {
		ensureWorkspace: async (input: EnsureWorkspaceInput) => {
			calls.push(`ensure:${input.sha}:${input.archiveUrl}`)
			return { _tag: "restored", bytes: 10 }
		},
		exec: async (input) => {
			calls.push(
				`exec:${input.command} ${input.args.join(" ")} @${input.cwd} env=${input.envAllow.join(",")}`,
			)
			return exec(input)
		},
	}
	return makeCloudflareRepoSandbox({
		resolveCheckout: (orgId, repository, ref) => {
			calls.push(`checkout:${orgId}:${repository}:${ref}`)
			return Effect.succeed(checkout)
		},
		stubFor: (orgId, resolved) => {
			calls.push(`stub:${orgId}:${resolved.fullName}`)
			return stub
		},
	})
}

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
	it.effect("resolves the checkout, restores it, runs the command and reports the events", () =>
		Effect.gen(function* () {
			const calls: string[] = []
			const sandbox = makeSandbox(
				() => ({
					_tag: "exited",
					exitCode: 1,
					stdout: "src/a.ts:1:x",
					stderr: "",
					stdoutBytes: 12,
					stderrBytes: 0,
					wallTimeMs: 40,
				}),
				calls,
			)
			const events = yield* Stream.runCollect(sandbox.execute(request()))
			assert.deepStrictEqual(
				events.map((event) => event._tag),
				["SandboxStarted", "SandboxOutput", "SandboxExited"],
			)
			const exited = events[2]
			assert.isTrue(exited?._tag === "SandboxExited" && exited.exitCode === 1)
			assert.isTrue(events.every((event) => event.implementation.isolation === "isolated"))
			assert.deepStrictEqual(calls, [
				`checkout:${ORG}:octo/shop:main`,
				`stub:${ORG}:octo/shop`,
				`ensure:${SHA}:${checkout.archiveUrl}`,
				`exec:rg -- . @src env=PATH`,
			])
		}),
	)

	it.effect("surfaces the container's bounds as the contract's failures", () =>
		Effect.gen(function* () {
			const timedOut = yield* Effect.exit(
				Stream.runCollect(
					makeSandbox(() => ({ _tag: "timed-out", wallTimeMs: 5000 })).execute(request()),
				),
			)
			assert.isTrue(
				Exit.isFailure(timedOut) &&
					timedOut.cause.reasons[0]?._tag === "Fail" &&
					timedOut.cause.reasons[0].error._tag === "SandboxTimeoutError",
			)
			const overflowed = yield* Effect.exit(
				Stream.runCollect(
					makeSandbox(() => ({
						_tag: "output-limit",
						stream: "stdout",
						limit: 1024,
						observed: 4096,
					})).execute(request()),
				),
			)
			assert.isTrue(
				overflowed.cause !== undefined &&
					Exit.isFailure(overflowed) &&
					overflowed.cause.reasons[0]?._tag === "Fail" &&
					overflowed.cause.reasons[0].error._tag === "SandboxOutputLimitError",
			)
		}),
	)

	it.effect("reports a deployment without the binding as unsupported rather than crashing", () =>
		Effect.gen(function* () {
			const sandbox = makeCloudflareRepoSandbox({
				resolveCheckout: () => Effect.succeed(checkout),
				stubFor: () => undefined,
			})
			const exit = yield* Effect.exit(Stream.runCollect(sandbox.execute(request())))
			assert.isTrue(
				Exit.isFailure(exit) &&
					exit.cause.reasons[0]?._tag === "Fail" &&
					exit.cause.reasons[0].error._tag === "SandboxUnsupportedRequestError",
			)
		}),
	)
})
