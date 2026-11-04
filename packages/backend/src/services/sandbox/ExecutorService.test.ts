import { assert, describe, it } from "@effect/vitest"
import {
	ExecutorNotPrepared,
	ExecutorPrepared,
	ExecutorPrepareFailed,
	type ExecutorPrepareRequest,
	type ExecutorPrepareResponse,
	ExecutorPreparing,
	ExecutorRunExited,
	type ExecutorRunRequest,
	type ExecutorRunResponse,
	ExecutorInstall,
	ExecutorDestroyed,
	ExecutorReleased,
	type ExecutorReleaseRequest,
	type ExecutorReleaseResponse,
	ExecutorUnavailable,
} from "@maple/domain/executor"
import { OrgId } from "@maple/domain/http"
import { SandboxCheckout } from "@maple/domain/sandbox"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import type { ExecutorTransport } from "@maple/backend/sandbox/client"
import { executorAgentId, executorKey, makeExecutor } from "./ExecutorService"

const orgId = Schema.decodeSync(OrgId)("org_test")
const SHA = Str.repeat(40)("d")
const target = { repository: "octo/shop", sha: SHA }
const RUN_ID = "7F3A2C10-1111-4222-8333-944455556666"

const exited = new ExecutorRunExited({
	exitCode: 0,
	timedOut: false,
	stdout: "ok",
	stderr: "",
	stdoutBytes: 2,
	stderrBytes: 0,
	wallTimeMs: 10,
	promoted: [],
	rejected: [],
})

/** A transport answering prepare and run from queues, recording every request. */
const fakeTransport = (
	prepares: Array<ExecutorPrepareResponse>,
	runs: Array<ExecutorRunResponse> = [],
	available = true,
	releases: Array<ExecutorReleaseResponse> = [],
) => {
	const prepared: Array<ExecutorPrepareRequest> = []
	const ran: Array<ExecutorRunRequest> = []
	const released: Array<ExecutorReleaseRequest> = []
	const transport: ExecutorTransport = {
		available,
		prepare: (request) =>
			Effect.sync(() => {
				prepared.push(request)
				return available ? Option.fromNullishOr(prepares.shift()) : Option.none()
			}),
		run: (request) =>
			Effect.sync(() => {
				ran.push(request)
				return available ? Option.fromNullishOr(runs.shift()) : Option.none()
			}),
		release: (request) =>
			Effect.sync(() => {
				released.push(request)
				return Option.fromNullishOr(releases.shift())
			}),
		destroy: () => Effect.succeedSome(new ExecutorDestroyed()),
	}
	return { transport, prepared, ran, released }
}

const executorOver = (transport: ExecutorTransport) =>
	makeExecutor({
		transport,
		preparePoll: "1 millis",
		checkout: () =>
			Effect.succeed(
				new SandboxCheckout({
					repository: "octo/shop",
					sha: SHA,
					remoteUrl: "https://github.com/octo/shop.git",
					token: "ghs_token",
				}),
			),
	})

const installs = [new ExecutorInstall({ dir: ".", manager: "npm", outcome: "installed", detail: "added 3" })]

describe("ExecutorService", () => {
	it.live("waits out a prepare in progress and answers its installs", () =>
		Effect.gen(function* () {
			const fake = fakeTransport([
				new ExecutorPreparing({ message: "fetching" }),
				new ExecutorPreparing({ message: "installing" }),
				new ExecutorPrepared({ installs }),
			])
			const answer = yield* executorOver(fake.transport).prepare(orgId, RUN_ID, target)
			assert.deepStrictEqual(answer, installs)
			assert.lengthOf(fake.prepared, 3)
			assert.strictEqual(fake.prepared[0]?.executorKey, "run-7f3a2c10-1111-4222-8333-944455556666")
		}),
	)

	it.live("fails a prepare that failed, and one on a deployment without an executor", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.flip(
				executorOver(
					fakeTransport([new ExecutorPrepareFailed({ message: "exit 11" })]).transport,
				).prepare(orgId, RUN_ID, target),
			)
			assert.strictEqual(failed.reason, "prepare_failed")
			const unbound = executorOver(fakeTransport([], [], false).transport)
			assert.isFalse(unbound.available)
			assert.strictEqual(
				(yield* Effect.flip(unbound.prepare(orgId, RUN_ID, target))).reason,
				"no_executor",
			)
		}),
	)

	it.live("prepares again once when the executor lost its container, then runs the command", () =>
		Effect.gen(function* () {
			const fake = fakeTransport(
				[new ExecutorPrepared({ installs })],
				[new ExecutorNotPrepared({ message: "container stopped" }), exited],
			)
			const answer = yield* executorOver(fake.transport).run(orgId, RUN_ID, target, {
				agentId: "Hunter_3.1",
				command: "node poc.js",
				cwd: "checkout",
				timeoutMs: 5000,
				promote: [],
			})
			assert.strictEqual(answer.stdout, "ok")
			assert.lengthOf(fake.prepared, 1)
			assert.deepStrictEqual(
				Arr.map(fake.ran, (request) => request.agentId),
				["hunter_3-1", "hunter_3-1"],
			)
		}),
	)

	it.live("fails a command when a second prepare still leaves it unprepared", () =>
		Effect.gen(function* () {
			const fake = fakeTransport(
				[new ExecutorPrepared({ installs })],
				[
					new ExecutorNotPrepared({ message: "gone" }),
					new ExecutorNotPrepared({ message: "gone again" }),
				],
			)
			const error = yield* Effect.flip(
				executorOver(fake.transport).run(orgId, RUN_ID, target, {
					agentId: "verifier",
					command: "true",
					cwd: "scratch",
					timeoutMs: 1000,
					promote: [],
				}),
			)
			assert.strictEqual(error.reason, "unavailable")
			assert.lengthOf(fake.ran, 2)
		}),
	)
})

describe("ExecutorService.release", () => {
	it.effect("releases each agent under its canonical id, whatever the executor answers", () =>
		Effect.gen(function* () {
			const fake = fakeTransport([], [], true, [
				new ExecutorReleased(),
				new ExecutorUnavailable({ message: "busy" }),
			])
			const executor = executorOver(fake.transport)
			// Best effort: a refused or silent release still lets the invocation end normally.
			const answers = yield* Effect.all([
				executor.release(RUN_ID, "Hunter 2-ab12cd34"),
				executor.release(RUN_ID, "verifier-1"),
				executor.release(RUN_ID, "verifier-2"),
			]).pipe(Effect.exit)
			assert.strictEqual(answers._tag, "Success")
			assert.deepStrictEqual(
				Arr.map(fake.released, (request) => [request.executorKey, request.agentId]),
				[
					[executorKey(RUN_ID), "hunter-2-ab12cd34"],
					[executorKey(RUN_ID), "verifier-1"],
					[executorKey(RUN_ID), "verifier-2"],
				],
			)
		}),
	)
})

describe("executor names", () => {
	it("keeps agent ids in the skill's canonical form", () => {
		assert.deepStrictEqual(
			Arr.map(["record-7-0", "Hunter 2", "-x", "con", Str.repeat(80)("a")], executorAgentId),
			["record-7-0", "hunter-2", "a-x", "acon", Str.repeat(64)("a")],
		)
		assert.match(executorKey(RUN_ID), /^[a-z0-9][a-z0-9-]{0,62}$/u)
	})
})
