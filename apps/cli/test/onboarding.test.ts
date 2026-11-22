import { describe, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { strict as assert } from "node:assert"
import { Array as Arr, Console, Duration, Effect, Exit, Option, Ref, Schema, String as Str } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { encodeJson } from "@maple/local-server/json"
import { HANDOFF_SPENT_MESSAGE, handoffLogin } from "../src/commands/auth"
import {
	describeReport,
	isTransientSearchFailure,
	isVerified,
	verificationStart,
} from "../src/commands/onboarding"
import { AuthorizationUnavailableError, publicHttpErrorBody, UnauthorizedError } from "@maple/domain/http"
import { makeV2Client } from "../src/core/v2-client"
import { V2OnboardingAgentRun } from "@maple/domain/http/v2"
import { MapleConfig, type MapleConfigValues } from "../src/core/config"
import {
	appUrlFor,
	ingestEndpointFor,
	onboardingKeys,
	reportProgress,
	waitForTrace,
} from "../src/core/onboarding"

const API = "https://api.maple.test"
const TARGET = { apiUrl: API, token: "maple_ak_test" }
const HANDOFF = "maple_ho_secret-handoff-code"

type Route = { readonly status: number; readonly body: unknown } | "refuse"
interface Sent {
	readonly method: string
	readonly path: string
	readonly body: string
}

const RUN = {
	object: "onboarding_agent_run",
	status: "in_progress",
	created_at: "2026-11-22T10:00:00.000Z",
	expires_at: "2026-11-23T10:00:00.000Z",
	last_reported_at: "2026-11-22T10:01:00.000Z",
	stages: [
		{
			object: "onboarding_agent_stage",
			id: "connect_agent",
			status: "completed",
			note: "maple CLI",
			updated_at: "2026-11-22T10:01:00.000Z",
		},
	],
	service_names: [],
	trace_id: null,
}

/** An HttpClient answering `METHOD /path` from a table, recording each request it gets. */
const fakeApi = (routes: Readonly<Record<string, Route>>, sent: Array<Sent>) =>
	HttpClient.make((request, url) =>
		Effect.gen(function* () {
			const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
			sent.push({ method: request.method, path: url.pathname, body })
			const route = routes[`${request.method} ${url.pathname}`] ?? {
				status: 404,
				body: { message: "nope" },
			}
			if (route === "refuse")
				return yield* new HttpClientError.HttpClientError({
					reason: new HttpClientError.TransportError({
						request,
						description: "connection refused",
					}),
				})
			return HttpClientResponse.fromWeb(
				request,
				new Response(encodeJson(route.body), { status: route.status }),
			)
		}),
	)

const fakeConfig = (saved: Array<{ token: string; managed: boolean }>): MapleConfigValues => ({
	apiUrl: Option.none(),
	token: Option.none(),
	orgId: Option.none(),
	userId: Option.none(),
	credentialStore: Option.none(),
	credentialManaged: false,
	tokenSource: "none",
	envTokenOverride: false,
	localUrl: "http://127.0.0.1:4318",
	defaultMode: Option.none(),
	defaultApiUrl: API,
	lastUpdateCheck: Option.none(),
	latestKnownVersion: Option.none(),
	lastSeenVersion: Option.none(),
	write: () => Effect.void,
	saveRemoteCredential: (next) =>
		Effect.sync(() => {
			saved.push({ token: next.token, managed: next.managed })
			return "keychain" as const
		}),
	clearRemoteCredential: Effect.void,
	setDefaultMode: () => Effect.void,
	clearDefaultMode: Effect.void,
	recordUpdateCheck: () => Effect.void,
})

const SESSION = { status: 200, body: { orgId: "org_1", userId: "user_1" } }

// Plain promises: `it.effect` hangs under `bun test`.
const runLogin = (routes: Readonly<Record<string, Route>>, apiUrl: string = API) => {
	const sent: Array<Sent> = []
	const saved: Array<{ token: string; managed: boolean }> = []
	const printed: Array<string> = []
	const capture = (...args: ReadonlyArray<unknown>) => {
		printed.push(Arr.join(Arr.map(args, String), " "))
	}
	// Everything the command prints, so a test can prove the code never appears in it.
	const capturing: Console.Console = {
		...globalThis.console,
		log: capture,
		error: capture,
		info: capture,
		warn: capture,
	}
	const exit = Effect.runPromiseExit(
		handoffLogin(apiUrl, HANDOFF).pipe(
			Effect.provideService(Console.Console, capturing),
			Effect.provideService(HttpClient.HttpClient, fakeApi(routes, sent)),
			Effect.provideService(MapleConfig, fakeConfig(saved)),
			Effect.provide(BunServices.layer),
		),
	)
	return exit.then((result) => ({ exit: result, sent, saved, printed }))
}

describe("handoff login", () => {
	it("signs in with one token request, saves the credential and reports connect_agent", async () => {
		const { exit, sent, saved, printed } = await runLogin({
			"POST /api/auth/cli/device/token": {
				status: 200,
				body: { status: "complete", token: "maple_ak_issued", orgId: "org_1", userId: "user_1" },
			},
			"GET /api/auth/session": SESSION,
			"POST /v2/onboarding/agent_run/status": { status: 200, body: RUN },
		})
		assert.ok(Exit.isSuccess(exit))
		assert.deepEqual(saved, [{ token: "maple_ak_issued", managed: true }])
		assert.ok(printed.length > 0)
		assert.ok(!Arr.some(printed, Str.includes(HANDOFF)))
		const tokenRequests = Arr.filter(sent, (r) => r.path === "/api/auth/cli/device/token")
		assert.equal(tokenRequests.length, 1)
		assert.deepEqual(JSON.parse(tokenRequests[0]?.body ?? ""), { deviceCode: HANDOFF })
		const report = Option.getOrUndefined(
			Arr.findFirst(sent, (r) => r.path === "/v2/onboarding/agent_run/status"),
		)
		assert.deepEqual(JSON.parse(report?.body ?? ""), {
			stage: "connect_agent",
			status: "completed",
			note: "maple CLI",
		})
	})

	it("never sends the code over plain HTTP to a remote API", async () => {
		const { exit, sent, saved } = await runLogin({}, "http://api.maple.test")
		assert.ok(Exit.isFailure(exit))
		assert.equal(sent.length, 0)
		assert.deepEqual(saved, [])
	})

	it("refuses an expired or spent code without saving anything", async () => {
		const { exit, saved, printed } = await runLogin({
			"POST /api/auth/cli/device/token": { status: 200, body: { status: "expired" } },
		})
		assert.ok(Exit.isFailure(exit))
		assert.ok(Exit.hasFails(exit))
		const error = Option.getOrUndefined(Arr.findFirst(exit.cause.reasons, (r) => r._tag === "Fail"))
		assert.equal(error?._tag === "Fail" ? error.error.message : undefined, HANDOFF_SPENT_MESSAGE)
		assert.ok(!Arr.some(printed, Str.includes(HANDOFF)))
		assert.deepEqual(saved, [])
	})

	it("still signs in when reporting progress fails", async () => {
		const { exit, saved } = await runLogin({
			"POST /api/auth/cli/device/token": {
				status: 200,
				body: { status: "complete", token: "maple_ak_issued", orgId: "org_1", userId: "user_1" },
			},
			"GET /api/auth/session": SESSION,
			"POST /v2/onboarding/agent_run/status": "refuse",
		})
		assert.ok(Exit.isSuccess(exit))
		assert.equal(saved.length, 1)
	})
})

const report = (route: Route) =>
	Effect.runPromise(
		reportProgress(TARGET, { stage: "instrument_app", status: "active" }).pipe(
			Effect.provideService(
				HttpClient.HttpClient,
				fakeApi({ "POST /v2/onboarding/agent_run/status": route }, []),
			),
		),
	)

describe("onboarding report", () => {
	it("treats a closed run and a missing run as answers, not failures", async () => {
		const closed = await report({
			status: 409,
			body: { error: { type: "conflict", code: "onboarding_agent_run_closed" } },
		})
		assert.equal(closed._tag, "closed")
		assert.deepEqual(describeReport(closed), { line: "run is closed; stop reporting", toStderr: false })

		const missing = await report({
			status: 404,
			body: { error: { code: "onboarding_agent_run_not_found" } },
		})
		assert.equal(missing._tag, "no_run")
		assert.equal(describeReport(missing).toStderr, false)
	})

	it("turns an unreachable API into a warning", async () => {
		const outcome = await report("refuse")
		assert.equal(outcome._tag, "failed")
		assert.equal(describeReport(outcome).toStderr, true)
	})

	it("returns the run after a report", async () => {
		const outcome = await report({ status: 200, body: RUN })
		assert.equal(outcome._tag === "reported" ? outcome.run.status : undefined, "in_progress")
	})
})

describe("onboarding keys", () => {
	it("prints the public key and region endpoint, never a private key", async () => {
		const sent: Array<Sent> = []
		const keys = await Effect.runPromise(
			onboardingKeys({ apiUrl: "https://api.eu.maple.dev", token: "t" }).pipe(
				Effect.provideService(
					HttpClient.HttpClient,
					fakeApi(
						{
							"GET /v2/ingest_keys/public": {
								status: 200,
								body: {
									object: "public_ingest_key",
									public_key: "maple_pk_abc",
									public_rotated_at: "2026-07-01T12:00:00.000Z",
									private_key: "maple_sk_leaked",
								},
							},
						},
						sent,
					),
				),
			),
		)
		assert.deepEqual(keys, { ingest_endpoint: "https://ingest.eu.maple.dev", public_key: "maple_pk_abc" })
		assert.ok(!Str.includes("maple_sk_")(encodeJson(keys)))
		assert.deepEqual(
			Arr.map(sent, (r) => r.path),
			["/v2/ingest_keys/public"],
		)
	})

	it("derives the ingest endpoint and dashboard from the API host", () => {
		assert.equal(ingestEndpointFor("https://api.maple.dev"), "https://ingest.maple.dev")
		assert.equal(ingestEndpointFor("https://api.eu.maple.dev"), "https://ingest.eu.maple.dev")
		assert.equal(ingestEndpointFor("https://api-pr-12.maple.dev"), "https://ingest-pr-12.maple.dev")
		assert.equal(appUrlFor("https://api.eu.maple.dev"), "https://app.eu.maple.dev")
		assert.equal(appUrlFor("https://api-pr-12.maple.dev"), "https://app-pr-12.maple.dev")
	})
})

describe("onboarding verify", () => {
	it("polls until a trace arrives", async () => {
		const found = await Effect.runPromise(
			Effect.gen(function* () {
				const polls = yield* Ref.make(0)
				const find = Ref.updateAndGet(polls, (n) => n + 1).pipe(
					Effect.map((n) =>
						n >= 3 ? Option.some("4bf92f3577b34da6a3ce929d0e0e4736") : Option.none(),
					),
				)
				const trace = yield* waitForTrace({
					find,
					timeout: Duration.seconds(5),
					interval: Duration.millis(5),
				})
				return { trace, polls: yield* Ref.get(polls) }
			}),
		)
		assert.deepEqual(found, { trace: Option.some("4bf92f3577b34da6a3ce929d0e0e4736"), polls: 3 })
	})

	it("gives up at the timeout", async () => {
		const found = await Effect.runPromise(
			waitForTrace({
				find: Effect.succeed(Option.none<string>()),
				timeout: Duration.millis(40),
				interval: Duration.millis(5),
			}),
		)
		assert.ok(Option.isNone(found))
	})
})

describe("verify retries", () => {
	/** What `verify`'s search fails with when the API answers `route`, through the real v2 client. */
	const searchFailure = (route: Route) =>
		Effect.gen(function* () {
			const client = yield* makeV2Client(API, "maple_ak_test")
			return yield* client.traces
				.search({
					payload: {
						start_time: "2026-11-22T10:00:00.000Z",
						end_time: "2026-11-22T10:15:00.000Z",
						limit: 1,
						filters: {},
					},
				})
				.pipe(Effect.flip)
		}).pipe(
			Effect.provideService(HttpClient.HttpClient, fakeApi({ "POST /v2/traces/search": route }, [])),
		)

	const envelope = (error: Parameters<typeof publicHttpErrorBody>[0]) => ({
		error: publicHttpErrorBody(error),
	})

	// Plain promises: `it.effect` hangs under `bun test`.
	it("fails at once on a refused key, but waits out an outage or a dropped connection", async () => {
		const failures = await Effect.runPromise(
			Effect.gen(function* () {
				const refused = yield* searchFailure({
					status: 401,
					body: envelope(new UnauthorizedError({ message: "Invalid API key" })),
				})

				const outage = yield* searchFailure({
					status: 503,
					body: envelope(new AuthorizationUnavailableError({ message: "down" })),
				})

				const dropped = yield* searchFailure("refuse")
				return { refused, outage, dropped }
			}),
		)
		assert.equal(isTransientSearchFailure(failures.refused), false)
		assert.equal(isTransientSearchFailure(failures.outage), true)
		assert.equal(isTransientSearchFailure(failures.dropped), true)
	})
})

describe("verify windows and outcomes", () => {
	it("never counts a trace sent before the run started", () => {
		const windowStart = "2026-11-22T16:00:00.000Z"
		assert.equal(
			verificationStart(windowStart, Option.some("2026-11-22T16:12:50.000Z")),
			"2026-11-22T16:12:50.000Z",
		)
		assert.equal(verificationStart(windowStart, Option.some("2026-11-22T15:00:00.000Z")), windowStart)
		assert.equal(verificationStart(windowStart, Option.none()), windowStart)
	})

	it("knows a verified run, so a later miss leaves it verified", () => {
		const withVerification = (status: string) =>
			Schema.decodeUnknownSync(V2OnboardingAgentRun)({
				...RUN,
				stages: [
					{
						object: "onboarding_agent_stage",
						id: "receive_verification",
						status,
						note: null,
						updated_at: null,
					},
				],
			})
		assert.equal(isVerified(withVerification("completed")), true)
		assert.equal(isVerified(withVerification("waiting")), false)
	})
})
