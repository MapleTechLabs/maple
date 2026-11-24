// BOUNDARY-FILE: The fake HTTP service models JSON documents owned by the Maple API.
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Layer, Schema, Array as Arr } from "effect"
import { noopSession } from "alchemy/Report"
import { UptimeMonitor, UptimeMonitorProvider, type UptimeMonitorProps } from "../src/UptimeMonitor"
import { MapleApi, type MapleApiContract } from "../src/MapleApi"
import { makeMapleApiResponseError, MapleErrorTags } from "../src/errors"

const decodeBody = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

/** One stored monitor; the API fills defaults the props never mention. */
const makeFake = () => {
	const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
	const store = new Map<string, Record<string, unknown>>()
	const notFound = makeMapleApiResponseError(404, {
		_tag: MapleErrorTags.uptimeMonitorNotFound,
		type: "not_found_error",
		code: "resource_missing",
		title: "Not found",
		message: "Uptime monitor not found",
		retryable: false,
		recovery: "none",
	})
	const withDefaults = (body: Record<string, unknown>, previous?: Record<string, unknown>) => {
		const merged = { ...previous, ...body }
		const config = decodeBody(merged.config)
		return {
			interval_seconds: 60,
			failures_to_down: 2,
			heartbeat_url: null,
			alert_rule_id: "alrt_1",
			...merged,
			config: config.type === "http" ? { method: "GET", ...config } : config,
		}
	}
	const api: MapleApiContract = {
		get: (path) =>
			Effect.suspend(() => {
				calls.push({ method: "GET", path })
				const doc = store.get(path)
				return doc === undefined ? Effect.fail(notFound) : Effect.succeed(structuredClone(doc))
			}),
		post: (path, body) =>
			Effect.sync(() => {
				calls.push({ method: "POST", path, body: decodeBody(body) })
				const doc = { id: "upm_1", ...withDefaults(decodeBody(body)) }
				store.set(`${path}/upm_1`, doc)
				return structuredClone(doc)
			}),
		patch: (path, body) =>
			Effect.suspend(() => {
				calls.push({ method: "PATCH", path, body: decodeBody(body) })
				const previous = store.get(path)
				if (previous === undefined) return Effect.fail(notFound)
				const doc = withDefaults(decodeBody(body), previous)
				store.set(path, doc)
				return Effect.succeed(structuredClone(doc))
			}),
		put: (path) => Effect.fail(makeMapleApiResponseError(404, { ...notFound.error, message: path })),
		delete: (path) =>
			Effect.sync(() => {
				calls.push({ method: "DELETE", path })
				store.delete(path)
			}),
		upload: (path) => Effect.die(`unexpected upload ${path}`),
	}
	return { api, calls, store }
}

const reconcile = (
	fake: ReturnType<typeof makeFake>,
	news: UptimeMonitorProps,
	previous?: { olds: UptimeMonitorProps; output: UptimeMonitor["Attributes"] },
) =>
	Effect.gen(function* () {
		const provider = yield* UptimeMonitor.Provider
		return yield* provider.reconcile({ ...args, news, olds: previous?.olds, output: previous?.output })
	}).pipe(Effect.provide(UptimeMonitorProvider().pipe(Layer.provide(Layer.succeed(MapleApi, fake.api)))))

const args = { id: "api", fqn: "test/api", instanceId: "i-1", session: noopSession, bindings: [] }

const http: UptimeMonitorProps = {
	name: "API health",
	config: { type: "http", url: "https://api.example.com/health", headers: { "x-check": "1" } },
}

describe("UptimeMonitorProvider", () => {
	it.live("creates with the kind taken from config.type", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const out = yield* reconcile(fake, http)
			expect(out).toMatchObject({ monitorId: "upm_1", kind: "http", alertRuleId: "alrt_1" })
			expect(fake.calls[0]).toMatchObject({
				method: "POST",
				body: { kind: "http", service_name: null, enabled: true },
			})
		}),
	)

	it.live("only reads when the API holds the props plus its own defaults", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const output = yield* reconcile(fake, http)
			fake.calls.length = 0
			yield* reconcile(fake, http, { olds: http, output })
			expect(Arr.map(fake.calls, (c) => c.method)).toEqual(["GET"])
		}),
	)

	it.live("repairs a declared field changed outside Alchemy", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const output = yield* reconcile(fake, http)
			fake.store.set("/v2/uptime_monitors/upm_1", {
				...fake.store.get("/v2/uptime_monitors/upm_1"),
				name: "Renamed in UI",
			})
			yield* reconcile(fake, http, { olds: http, output })
			expect(fake.store.get("/v2/uptime_monitors/upm_1")?.name).toBe("API health")
		}),
	)

	it.live("clears a config key removed from the props", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const output = yield* reconcile(fake, http)
			expect(decodeBody(fake.store.get("/v2/uptime_monitors/upm_1")?.config).headers).toEqual({
				"x-check": "1",
			})
			const news: UptimeMonitorProps = {
				...http,
				config: { type: "http", url: "https://api.example.com/health" },
			}
			yield* reconcile(fake, news, { olds: http, output })
			// The API answers an omitted map with an empty one; either way nothing is sent.
			const { headers } = decodeBody(fake.store.get("/v2/uptime_monitors/upm_1")?.config)
			expect(headers === undefined ? {} : headers).toEqual({})
		}),
	)

	it.live("replaces the monitor when config.type changes", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const output = yield* reconcile(fake, http)
			const tcp: UptimeMonitorProps = {
				name: "API port",
				config: { type: "tcp", host: "api.example.com", port: 443 },
			}
			const diff = yield* Effect.gen(function* () {
				const provider = yield* UptimeMonitor.Provider
				return yield* provider.diff!({
					id: "api",
					fqn: "test/api",
					instanceId: "i-1",
					olds: http,
					news: tcp,
					output,
					oldBindings: [],
					newBindings: [],
				})
			}).pipe(
				Effect.provide(
					UptimeMonitorProvider().pipe(Layer.provide(Layer.succeed(MapleApi, fake.api))),
				),
			)
			expect(diff?.action).toBe("replace")
		}),
	)
})
