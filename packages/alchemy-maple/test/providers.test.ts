// BOUNDARY-FILE: Test doubles mirror intentionally untyped external callbacks.
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { noopSession } from "alchemy/Report"
import { AlertDestination, AlertDestinationProvider } from "../src/AlertDestination"
import { ApiKey, ApiKeyProvider } from "../src/ApiKey"
import { Dashboard, DashboardProvider } from "../src/Dashboard"
import { MapleApi, type MapleApiContract } from "../src/MapleApi"
import { makeMapleApiResponseError, type MapleError } from "../src/errors"

const missingRoute = (message: string) =>
	makeMapleApiResponseError(404, {
		_tag: "@maple/http/errors/DashboardNotFoundError",
		type: "not_found_error",
		code: "resource_missing",
		title: "Not found",
		message,
		retryable: false,
		recovery: "none",
	})

/** In-memory stub of the v2 API: canned responses + a call log. */
const makeStub = (
	routes: Record<string, (body?: unknown) => Effect.Effect<unknown, MapleError>>,
): { api: MapleApiContract; calls: Array<string> } => {
	const calls: Array<string> = []
	const dispatch = (method: string, path: string, body?: unknown) => {
		calls.push(`${method} ${path}`)
		const handler = routes[`${method} ${path}`]
		if (handler === undefined) {
			return Effect.fail<MapleError>(missingRoute(`no route: ${method} ${path}`))
		}
		return handler(body)
	}
	return {
		calls,
		api: {
			get: (path) => dispatch("GET", path),
			post: (path, body) => dispatch("POST", path, body),
			patch: (path, body) => dispatch("PATCH", path, body),
			delete: (path) => dispatch("DELETE", path),
		},
	}
}

const session = noopSession

const wireDashboard = {
	id: "dash_abc",
	object: "dashboard",
	name: "Service health",
	description: null,
	tags: [],
	time_range: { type: "relative", value: "12h" },
	widgets: [],
	variables: [],
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-01T12:00:00.000Z",
}

const runWithProvider = <A, E, R>(api: MapleApiContract, program: Effect.Effect<A, E, R>) => {
	const apiLayer = Layer.succeed(MapleApi, api)
	return program.pipe(
		Effect.provide([
			DashboardProvider().pipe(Layer.provide(apiLayer)),
			ApiKeyProvider().pipe(Layer.provide(apiLayer)),
			AlertDestinationProvider().pipe(Layer.provide(apiLayer)),
		]),
	)
}

describe("DashboardProvider", () => {
	it.live("creates when there is no prior state", () =>
		Effect.gen(function* () {
			const stub = makeStub({
				"POST /v2/dashboards": () => Effect.succeed(wireDashboard),
			})
			const attributes = yield* runWithProvider(
				stub.api,
				Effect.gen(function* () {
					const provider = yield* Dashboard.Provider
					return yield* provider.reconcile({
						id: "service-health",
						fqn: "test/service-health",
						instanceId: "i-1",
						news: { name: "Service health" },
						olds: undefined,
						output: undefined,
						session,
						bindings: [],
					})
				}),
			)
			expect(attributes).toEqual({
				dashboardId: "dash_abc",
				name: "Service health",
				configuration: { name: "Service health" },
			})
			expect(stub.calls).toEqual(["POST /v2/dashboards"])
		}),
	)

	it.live("observes without mutating when nothing drifted", () =>
		Effect.gen(function* () {
			const stub = makeStub({
				"GET /v2/dashboards/dash_abc": () => Effect.succeed(wireDashboard),
			})
			yield* runWithProvider(
				stub.api,
				Effect.gen(function* () {
					const provider = yield* Dashboard.Provider
					return yield* provider.reconcile({
						id: "service-health",
						fqn: "test/service-health",
						instanceId: "i-1",
						news: { name: "Service health" },
						olds: { name: "Service health" },
						output: { dashboardId: "dash_abc", name: "Service health" },
						session,
						bindings: [],
					})
				}),
			)
			expect(stub.calls).toEqual(["GET /v2/dashboards/dash_abc"])
		}),
	)

	it.live("patches when a declared field drifted", () =>
		Effect.gen(function* () {
			const stub = makeStub({
				"GET /v2/dashboards/dash_abc": () => Effect.succeed(wireDashboard),
				"PATCH /v2/dashboards/dash_abc": (body) =>
					Effect.succeed({ ...wireDashboard, ...(body as object) }),
			})
			const attributes = yield* runWithProvider(
				stub.api,
				Effect.gen(function* () {
					const provider = yield* Dashboard.Provider
					return yield* provider.reconcile({
						id: "service-health",
						fqn: "test/service-health",
						instanceId: "i-1",
						news: { name: "Renamed", tags: ["golden"] },
						olds: { name: "Service health" },
						output: { dashboardId: "dash_abc", name: "Service health" },
						session,
						bindings: [],
					})
				}),
			)
			expect(attributes.name).toBe("Renamed")
			expect(stub.calls).toEqual(["GET /v2/dashboards/dash_abc", "PATCH /v2/dashboards/dash_abc"])
		}),
	)

	it.live("recreates after an out-of-band delete", () =>
		Effect.gen(function* () {
			const stub = makeStub({
				"POST /v2/dashboards": () => Effect.succeed(wireDashboard),
			})
			yield* runWithProvider(
				stub.api,
				Effect.gen(function* () {
					const provider = yield* Dashboard.Provider
					return yield* provider.reconcile({
						id: "service-health",
						fqn: "test/service-health",
						instanceId: "i-1",
						news: { name: "Service health" },
						olds: { name: "Service health" },
						output: { dashboardId: "dash_gone", name: "Service health" },
						session,
						bindings: [],
					})
				}),
			)
			expect(stub.calls).toEqual(["GET /v2/dashboards/dash_gone", "POST /v2/dashboards"])
		}),
	)

	it.live("delete tolerates 404", () =>
		Effect.gen(function* () {
			const stub = makeStub({})
			yield* runWithProvider(
				stub.api,
				Effect.gen(function* () {
					const provider = yield* Dashboard.Provider
					yield* provider.delete({
						id: "service-health",
						fqn: "test/service-health",
						instanceId: "i-1",
						olds: { name: "Service health" },
						output: { dashboardId: "dash_gone", name: "Service health" },
						session,
						bindings: [],
					})
				}),
			)
			expect(stub.calls).toEqual(["DELETE /v2/dashboards/dash_gone"])
		}),
	)
})

const wireApiKey = {
	id: "key_abc",
	object: "api_key",
	name: "ci",
	key_prefix: "maple_ak_9f2c",
	revoked: false,
}

describe("ApiKeyProvider", () => {
	it.live("captures the one-time secret on create", () =>
		Effect.gen(function* () {
			const stub = makeStub({
				"POST /v2/api_keys": () => Effect.succeed({ ...wireApiKey, secret: "maple_ak_secret1" }),
			})
			const attributes = yield* runWithProvider(
				stub.api,
				Effect.gen(function* () {
					const provider = yield* ApiKey.Provider
					return yield* provider.reconcile({
						id: "ci",
						fqn: "test/ci",
						instanceId: "i-1",
						news: { name: "ci" },
						olds: undefined,
						output: undefined,
						session,
						bindings: [],
					})
				}),
			)
			expect(Redacted.value(attributes.secret)).toBe("maple_ak_secret1")
		}),
	)

	it.live("preserves the stored secret on steady-state reconcile", () =>
		Effect.gen(function* () {
			const stub = makeStub({
				"GET /v2/api_keys/key_abc": () => Effect.succeed(wireApiKey),
			})
			const secret = Redacted.make("maple_ak_secret1")
			const attributes = yield* runWithProvider(
				stub.api,
				Effect.gen(function* () {
					const provider = yield* ApiKey.Provider
					return yield* provider.reconcile({
						id: "ci",
						fqn: "test/ci",
						instanceId: "i-1",
						news: { name: "ci" },
						olds: { name: "ci" },
						output: { keyId: "key_abc", name: "ci", keyPrefix: "maple_ak_9f2c", secret },
						session,
						bindings: [],
					})
				}),
			)
			expect(Redacted.value(attributes.secret)).toBe("maple_ak_secret1")
			expect(stub.calls).toEqual(["GET /v2/api_keys/key_abc"])
		}),
	)

	it.live("rolls in place when `rotate` is bumped", () =>
		Effect.gen(function* () {
			const stub = makeStub({
				"GET /v2/api_keys/key_abc": () => Effect.succeed(wireApiKey),
				"POST /v2/api_keys/key_abc/roll": () =>
					Effect.succeed({ ...wireApiKey, id: "key_new", secret: "maple_ak_secret2" }),
			})
			const attributes = yield* runWithProvider(
				stub.api,
				Effect.gen(function* () {
					const provider = yield* ApiKey.Provider
					return yield* provider.reconcile({
						id: "ci",
						fqn: "test/ci",
						instanceId: "i-1",
						news: { name: "ci", rotate: 2 },
						olds: { name: "ci", rotate: 1 },
						output: {
							keyId: "key_abc",
							name: "ci",
							keyPrefix: "maple_ak_9f2c",
							secret: Redacted.make("maple_ak_secret1"),
						},
						session,
						bindings: [],
					})
				}),
			)
			expect(attributes.keyId).toBe("key_new")
			expect(Redacted.value(attributes.secret)).toBe("maple_ak_secret2")
		}),
	)

	it.live("recreates when the key was revoked out-of-band", () =>
		Effect.gen(function* () {
			const stub = makeStub({
				"GET /v2/api_keys/key_abc": () => Effect.succeed({ ...wireApiKey, revoked: true }),
				"POST /v2/api_keys": () =>
					Effect.succeed({ ...wireApiKey, id: "key_new", secret: "maple_ak_secret2" }),
			})
			const attributes = yield* runWithProvider(
				stub.api,
				Effect.gen(function* () {
					const provider = yield* ApiKey.Provider
					return yield* provider.reconcile({
						id: "ci",
						fqn: "test/ci",
						instanceId: "i-1",
						news: { name: "ci" },
						olds: { name: "ci" },
						output: {
							keyId: "key_abc",
							name: "ci",
							keyPrefix: "maple_ak_9f2c",
							secret: Redacted.make("maple_ak_secret1"),
						},
						session,
						bindings: [],
					})
				}),
			)
			expect(attributes.keyId).toBe("key_new")
		}),
	)
})

describe("AlertDestinationProvider", () => {
	const wireLinear = (teamId: string) => ({
		id: "dest_lin",
		object: "alert_destination",
		name: "Engineering triage",
		type: "linear",
		enabled: true,
		summary: "Linear · Engineering",
		channel_label: "ENG",
		linear_team_id: teamId,
	})
	const props = { type: "linear" as const, name: "Engineering triage", team_id: "team_1" }
	const output = {
		destinationId: "dest_lin",
		name: "Engineering triage",
		type: "linear",
		enabled: true,
		channelLabel: "ENG",
	}

	const reconcile = (stub: ReturnType<typeof makeStub>) =>
		runWithProvider(
			stub.api,
			Effect.gen(function* () {
				const provider = yield* AlertDestination.Provider
				return yield* provider.reconcile({
					id: "linear",
					fqn: "test/linear",
					instanceId: "i-1",
					news: props,
					olds: props,
					output,
					session,
					bindings: [],
				})
			}),
		)

	it.live("leaves a Linear destination alone when its team matches", () =>
		Effect.gen(function* () {
			const stub = makeStub({
				"GET /v2/alerts/destinations/dest_lin": () => Effect.succeed(wireLinear("team_1")),
			})
			yield* reconcile(stub)
			expect(stub.calls).toEqual(["GET /v2/alerts/destinations/dest_lin"])
		}),
	)

	it.live("patches a Linear destination whose team was changed outside IaC", () =>
		Effect.gen(function* () {
			const stub = makeStub({
				"GET /v2/alerts/destinations/dest_lin": () => Effect.succeed(wireLinear("team_other")),
				"PATCH /v2/alerts/destinations/dest_lin": (body) => {
					expect(body).toEqual(expect.objectContaining({ team_id: "team_1" }))
					return Effect.succeed(wireLinear("team_1"))
				},
			})
			yield* reconcile(stub)
			expect(stub.calls).toContain("PATCH /v2/alerts/destinations/dest_lin")
		}),
	)
})

describe("AlertDestinationProvider: incident.io", () => {
	const wireIncidentIo = (sourceId: string) => ({
		id: "dest_inc",
		object: "alert_destination",
		name: "Paging",
		type: "incident-io",
		enabled: true,
		summary: `Alert source ${sourceId}`,
		channel_label: sourceId,
	})
	const props = {
		type: "incident-io" as const,
		name: "Paging",
		alert_source_config_id: " 01GW2G3V0S59R238FAHPDS1R66 ",
		token: Redacted.make("inc-token"),
	}
	const output = {
		destinationId: "dest_inc",
		name: "Paging",
		type: "incident-io",
		enabled: true,
		channelLabel: "01GW2G3V0S59R238FAHPDS1R66",
	}

	it.live("reads the alert source ID back, so a change outside IaC is drift", () =>
		Effect.gen(function* () {
			const stub = makeStub({
				"GET /v2/alerts/destinations/dest_inc": () => Effect.succeed(wireIncidentIo("01HZOTHER")),
			})
			const attributes = yield* runWithProvider(
				stub.api,
				Effect.gen(function* () {
					const { read } = yield* AlertDestination.Provider
					if (read === undefined) return yield* Effect.die("AlertDestination has no read")
					return yield* read({ id: "inc", fqn: "test/inc", instanceId: "i-1", olds: props, output })
				}),
			)
			expect(attributes?.channelLabel).toBe("01HZOTHER")
		}),
	)

	it.live("converges on a padded source ID and patches one changed outside IaC", () =>
		Effect.gen(function* () {
			const reconcile = (stub: ReturnType<typeof makeStub>) =>
				runWithProvider(
					stub.api,
					Effect.gen(function* () {
						const provider = yield* AlertDestination.Provider
						return yield* provider.reconcile({
							id: "inc",
							fqn: "test/inc",
							instanceId: "i-1",
							news: props,
							olds: props,
							output,
							session,
							bindings: [],
						})
					}),
				)
			const same = makeStub({
				"GET /v2/alerts/destinations/dest_inc": () =>
					Effect.succeed(wireIncidentIo("01GW2G3V0S59R238FAHPDS1R66")),
			})
			yield* reconcile(same)
			expect(same.calls).toEqual(["GET /v2/alerts/destinations/dest_inc"])

			const moved = makeStub({
				"GET /v2/alerts/destinations/dest_inc": () => Effect.succeed(wireIncidentIo("01HZOTHER")),
				"PATCH /v2/alerts/destinations/dest_inc": (body) => {
					expect(body).toEqual(
						expect.objectContaining({
							alert_source_config_id: "01GW2G3V0S59R238FAHPDS1R66",
							token: "inc-token",
						}),
					)
					return Effect.succeed(wireIncidentIo("01GW2G3V0S59R238FAHPDS1R66"))
				},
			})
			yield* reconcile(moved)
			expect(moved.calls).toContain("PATCH /v2/alerts/destinations/dest_inc")
		}),
	)
})
