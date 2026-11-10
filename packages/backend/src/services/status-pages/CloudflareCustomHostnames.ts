import { Context, Effect, Layer, Option, Redacted, Ref, Schema, Array as Arr, String as Str } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Env } from "@maple/backend/platform/Env"

// Cloudflare for SaaS, for status page custom domains: a custom hostname (with its DV
// certificate) per domain, and a Worker route sending that hostname's traffic to the status
// Worker. One zone holds them all; see docs/status-page-custom-domains.md.

/** Custom domains are not set up on this deployment (zone, token, CNAME target or Worker name missing). */
export class CustomHostnamesNotConfiguredError extends Schema.TaggedError<CustomHostnamesNotConfiguredError>()(
	"@maple/backend/status-pages/CustomHostnamesNotConfiguredError",
	{ message: Schema.String },
) {}

/** A Cloudflare API call failed: network, an unreadable answer, or an error Cloudflare returned. */
export class CustomHostnamesApiError extends Schema.TaggedError<CustomHostnamesApiError>()(
	"@maple/backend/status-pages/CustomHostnamesApiError",
	{
		message: Schema.String,
		operation: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** The zone already has this hostname: another Maple deployment, or an account, added it first. */
export class CustomHostnameConflictError extends Schema.TaggedError<CustomHostnameConflictError>()(
	"@maple/backend/status-pages/CustomHostnameConflictError",
	{ message: Schema.String, hostname: Schema.String },
) {}

export type CustomHostnamesError = CustomHostnamesNotConfiguredError | CustomHostnamesApiError

/** One certificate validation token: a TXT record (`txt` method) or an HTTP file Cloudflare serves itself. */
export interface CustomHostnameValidationRecord {
	readonly txtName: string | null
	readonly txtValue: string | null
}

/** What Cloudflare says about one custom hostname. */
export interface CustomHostnameState {
	readonly id: string
	readonly hostname: string
	/** `pending`, `active`, `moved`, `blocked`, … (Cloudflare's hostname status). */
	readonly status: string
	/** `initializing`, `pending_validation`, `active`, `validation_timed_out`, …; null before a certificate exists. */
	readonly sslStatus: string | null
	/** The `_cf-custom-hostname` TXT record that proves ownership before the CNAME is live. */
	readonly ownership: { readonly name: string; readonly value: string } | null
	readonly validationRecords: ReadonlyArray<CustomHostnameValidationRecord>
	/** Cloudflare's own explanations: hostname verification errors, then certificate validation errors. */
	readonly errors: ReadonlyArray<string>
}

export interface CloudflareCustomHostnamesApi {
	/** The hostname customers CNAME to; none when custom domains are not set up here. */
	readonly cnameTarget: Option.Option<string>
	readonly createHostname: (
		hostname: string,
	) => Effect.Effect<CustomHostnameState, CustomHostnamesError | CustomHostnameConflictError>
	/** None when Cloudflare no longer has it. */
	readonly getHostname: (
		id: string,
	) => Effect.Effect<Option.Option<CustomHostnameState>, CustomHostnamesError>
	/** Asks Cloudflare to validate again now (the documented PATCH with the create's SSL settings). */
	readonly revalidateHostname: (
		id: string,
	) => Effect.Effect<Option.Option<CustomHostnameState>, CustomHostnamesError>
	/** Gone already is success. */
	readonly deleteHostname: (id: string) => Effect.Effect<void, CustomHostnamesError>
	/** Routes `<hostname>/*` to the status Worker; an existing route for the pattern is taken over. Answers its id. */
	readonly createRoute: (hostname: string) => Effect.Effect<string, CustomHostnamesError>
	/** Gone already is success. */
	readonly deleteRoute: (id: string) => Effect.Effect<void, CustomHostnamesError>
}

/** Domain-validated certificate, validated over HTTP: the customer's CNAME is all it needs. */
const SSL_SETTINGS = { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } as const

const CloudflareMessage = Schema.Struct({ code: Schema.optionalKey(Schema.Number), message: Schema.String })

const Envelope = <S extends Schema.Top>(result: S) =>
	Schema.Struct({
		success: Schema.Boolean,
		errors: Schema.optionalKey(Schema.Array(CloudflareMessage)),
		result: Schema.optionalKey(Schema.NullOr(result)),
	})

const HostnameResult = Schema.Struct({
	id: Schema.String,
	hostname: Schema.String,
	status: Schema.optionalKey(Schema.String),
	ssl: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				status: Schema.optionalKey(Schema.String),
				validation_records: Schema.optionalKey(
					Schema.Array(
						Schema.Struct({
							txt_name: Schema.optionalKey(Schema.String),
							txt_value: Schema.optionalKey(Schema.String),
						}),
					),
				),
				validation_errors: Schema.optionalKey(
					Schema.Array(Schema.Struct({ message: Schema.String })),
				),
			}),
		),
	),
	ownership_verification: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				name: Schema.optionalKey(Schema.String),
				value: Schema.optionalKey(Schema.String),
			}),
		),
	),
	verification_errors: Schema.optionalKey(Schema.Array(Schema.String)),
})

const RouteResult = Schema.Struct({ id: Schema.String, pattern: Schema.optionalKey(Schema.String) })

const HostnameEnvelope = Envelope(HostnameResult)
const RouteEnvelope = Envelope(RouteResult)
const RoutesEnvelope = Envelope(Schema.Array(RouteResult))
const AnyEnvelope = Envelope(Schema.Unknown)

const toState = (result: typeof HostnameResult.Type): CustomHostnameState => {
	const ownership = result.ownership_verification
	return {
		id: result.id,
		hostname: result.hostname,
		status: result.status ?? "pending",
		sslStatus: result.ssl?.status ?? null,
		ownership:
			ownership?.name !== undefined && ownership.value !== undefined
				? { name: ownership.name, value: ownership.value }
				: null,
		validationRecords: Arr.map(result.ssl?.validation_records ?? [], (record) => ({
			txtName: record.txt_name ?? null,
			txtValue: record.txt_value ?? null,
		})),
		errors: [
			...(result.verification_errors ?? []),
			...Arr.map(result.ssl?.validation_errors ?? [], (error) => error.message),
		],
	}
}

/** Cloudflare's "duplicate custom hostname" and "route already exists" codes. */
const DUPLICATE_HOSTNAME_CODES: ReadonlySet<number> = new Set([1406, 1407])
const DUPLICATE_ROUTE_CODE = 10020

interface Configured {
	readonly zoneId: string
	readonly token: Redacted.Redacted
	readonly workerName: string
}

export class CloudflareCustomHostnames extends Context.Service<
	CloudflareCustomHostnames,
	CloudflareCustomHostnamesApi
>()("@maple/backend/services/status-pages/CloudflareCustomHostnames", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const httpClient = yield* HttpClient.HttpClient
		const baseUrl = Str.replace(/\/+$/u, "")(env.MAPLE_CLOUDFLARE_API_BASE_URL)
		const cnameTarget = env.MAPLE_STATUS_DOMAINS_CNAME_TARGET
		const configured: Option.Option<Configured> = Option.all({
			zoneId: env.MAPLE_STATUS_DOMAINS_ZONE_ID,
			token: env.MAPLE_STATUS_DOMAINS_API_TOKEN,
			workerName: env.MAPLE_STATUS_WORKER_NAME,
			cnameTarget,
		})

		const requireConfigured = Effect.fromOption(configured).pipe(
			Effect.mapError(
				() =>
					new CustomHostnamesNotConfiguredError({
						message: "Custom domains are not configured on this deployment",
					}),
			),
		)

		/** One API call: its status and decoded envelope, never failing on a Cloudflare error body. */
		const call = <S extends Schema.Decoder<unknown>>(
			operation: string,
			method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
			path: (config: Configured) => string,
			schema: S,
			body?: unknown,
		) =>
			Effect.gen(function* () {
				const config = yield* requireConfigured
				const failed = (cause: unknown, status?: number) =>
					new CustomHostnamesApiError({
						message: `Cloudflare ${operation} failed`,
						operation,
						...(status === undefined ? undefined : { status }),
						cause,
					})
				const base = HttpClientRequest.make(method)(`${baseUrl}${path(config)}`).pipe(
					HttpClientRequest.bearerToken(Redacted.value(config.token)),
				)
				const request = body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body)
				const response = yield* httpClient.execute(request).pipe(Effect.mapError((e) => failed(e)))
				yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
				const json = yield* response.json.pipe(Effect.mapError((e) => failed(e, response.status)))
				const decoded = yield* Schema.decodeEffect(schema)(json).pipe(
					Effect.mapError((e) => failed(e, response.status)),
				)
				return { status: response.status, decoded, failed }
			}).pipe(
				Effect.withSpan(`CloudflareCustomHostnames.${operation}`, {
					kind: "client",
					attributes: { "peer.service": "cloudflare-api", "maple.cloudflare.operation": operation },
				}),
			)

		const firstMessage = (errors: ReadonlyArray<typeof CloudflareMessage.Type> | undefined) =>
			errors?.[0]?.message ?? "Cloudflare refused the request"

		const hostnamePath = (config: Configured, id = "") =>
			`/zones/${config.zoneId}/custom_hostnames${id === "" ? "" : `/${encodeURIComponent(id)}`}`
		const routesPath = (config: Configured, id = "") =>
			`/zones/${config.zoneId}/workers/routes${id === "" ? "" : `/${encodeURIComponent(id)}`}`

		const createHostname = (
			hostname: string,
		): Effect.Effect<CustomHostnameState, CustomHostnamesError | CustomHostnameConflictError> =>
			call("createHostname", "POST", (config) => hostnamePath(config), HostnameEnvelope, {
				hostname,
				ssl: SSL_SETTINGS,
			}).pipe(
				Effect.flatMap(
					({
						status,
						decoded,
						failed,
					}): Effect.Effect<
						CustomHostnameState,
						CustomHostnamesApiError | CustomHostnameConflictError
					> => {
						if (decoded.success && decoded.result) return Effect.succeed(toState(decoded.result))
						const duplicate = Arr.some(
							decoded.errors ?? [],
							(error) => error.code !== undefined && DUPLICATE_HOSTNAME_CODES.has(error.code),
						)
						return duplicate
							? Effect.fail(
									new CustomHostnameConflictError({
										message: `${hostname} is already added to Cloudflare elsewhere`,
										hostname,
									}),
								)
							: Effect.fail(failed(new Error(firstMessage(decoded.errors)), status))
					},
				),
			)

		const readHostname = (operation: string, method: "GET" | "PATCH", body?: unknown) => (id: string) =>
			call(operation, method, (config) => hostnamePath(config, id), HostnameEnvelope, body).pipe(
				Effect.flatMap(({ status, decoded, failed }) => {
					if (status === 404) return Effect.succeed(Option.none<CustomHostnameState>())
					if (decoded.success && decoded.result) return Effect.succeedSome(toState(decoded.result))
					return Effect.fail(failed(new Error(firstMessage(decoded.errors)), status))
				}),
			)

		const deleteBy = (operation: string, path: (config: Configured) => string) =>
			call(operation, "DELETE", path, AnyEnvelope).pipe(
				Effect.flatMap(({ status, decoded, failed }) =>
					decoded.success || status === 404
						? Effect.void
						: Effect.fail(failed(new Error(firstMessage(decoded.errors)), status)),
				),
			)

		const createRoute = (hostname: string) =>
			Effect.gen(function* () {
				const config = yield* requireConfigured
				const pattern = `${hostname}/*`
				const created = yield* call("createRoute", "POST", (c) => routesPath(c), RouteEnvelope, {
					pattern,
					script: config.workerName,
				})
				if (created.decoded.success && created.decoded.result) return created.decoded.result.id
				const duplicate = Arr.some(
					created.decoded.errors ?? [],
					(error) => error.code === DUPLICATE_ROUTE_CODE,
				)
				if (!duplicate)
					return yield* created.failed(
						new Error(firstMessage(created.decoded.errors)),
						created.status,
					)
				// An earlier attempt created it without recording the id: take it over for our Worker.
				const listed = yield* call("listRoutes", "GET", (c) => routesPath(c), RoutesEnvelope)
				const existing = Arr.findFirst(
					listed.decoded.result ?? [],
					(route) => route.pattern === pattern,
				)
				if (Option.isNone(existing))
					return yield* listed.failed(new Error(`No route found for ${pattern}`), listed.status)
				const updated = yield* call(
					"updateRoute",
					"PUT",
					(c) => routesPath(c, existing.value.id),
					RouteEnvelope,
					{ pattern, script: config.workerName },
				)
				if (!updated.decoded.success)
					return yield* updated.failed(
						new Error(firstMessage(updated.decoded.errors)),
						updated.status,
					)
				return existing.value.id
			})

		return {
			cnameTarget: Option.isSome(configured) ? cnameTarget : Option.none(),
			createHostname,
			getHostname: readHostname("getHostname", "GET"),
			revalidateHostname: readHostname("revalidateHostname", "PATCH", { ssl: SSL_SETTINGS }),
			deleteHostname: (id) => deleteBy("deleteHostname", (config) => hostnamePath(config, id)),
			createRoute,
			deleteRoute: (id) => deleteBy("deleteRoute", (config) => routesPath(config, id)),
		} satisfies CloudflareCustomHostnamesApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))

	/** A test double holding hostnames and routes in memory, plus handles to drive Cloudflare's side. */
	static readonly makeInMemory = (options: { readonly cnameTarget?: string | null } = {}) =>
		Effect.gen(function* () {
			const hostnames = yield* Ref.make<ReadonlyMap<string, CustomHostnameState>>(new Map())
			const routes = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
			const failing = yield* Ref.make(false)
			const counter = yield* Ref.make(0)
			const nextId = (prefix: string) =>
				Ref.updateAndGet(counter, (n) => n + 1).pipe(Effect.map((n) => `${prefix}-${n}`))
			const target =
				options.cnameTarget === undefined ? "status-domains.maple.test" : options.cnameTarget
			const guard = (operation: string) =>
				Effect.gen(function* () {
					if (target === null)
						return yield* new CustomHostnamesNotConfiguredError({
							message: "Custom domains are not configured on this deployment",
						})
					if (yield* Ref.get(failing))
						return yield* new CustomHostnamesApiError({
							message: `Cloudflare ${operation} failed`,
							operation,
							status: 503,
						})
				})
			const read = (id: string) =>
				Ref.get(hostnames).pipe(Effect.map((map) => Option.fromUndefinedOr(map.get(id))))
			const api: CloudflareCustomHostnamesApi = {
				cnameTarget: Option.fromNullishOr(target),
				createHostname: (hostname) =>
					Effect.gen(function* () {
						yield* guard("createHostname")
						const taken = Arr.some(
							[...(yield* Ref.get(hostnames)).values()],
							(h) => h.hostname === hostname,
						)
						if (taken)
							return yield* new CustomHostnameConflictError({
								message: `${hostname} is already added to Cloudflare elsewhere`,
								hostname,
							})
						const id = yield* nextId("cfh")
						const state: CustomHostnameState = {
							id,
							hostname,
							status: "pending",
							sslStatus: "initializing",
							ownership: { name: `_cf-custom-hostname.${hostname}`, value: `owner-${id}` },
							validationRecords: [],
							errors: ["custom hostname does not CNAME to this zone."],
						}
						yield* Ref.update(hostnames, (map) => new Map([...map, [id, state]]))
						return state
					}),
				getHostname: (id) => guard("getHostname").pipe(Effect.andThen(read(id))),
				revalidateHostname: (id) => guard("revalidateHostname").pipe(Effect.andThen(read(id))),
				deleteHostname: (id) =>
					guard("deleteHostname").pipe(
						Effect.andThen(
							Ref.update(
								hostnames,
								(map) => new Map(Arr.filter([...map], ([key]) => key !== id)),
							),
						),
					),
				createRoute: (hostname) =>
					Effect.gen(function* () {
						yield* guard("createRoute")
						const existing = Arr.findFirst(
							[...(yield* Ref.get(routes))],
							([, h]) => h === hostname,
						)
						if (Option.isSome(existing)) return existing.value[0]
						const id = yield* nextId("route")
						yield* Ref.update(routes, (map) => new Map([...map, [id, hostname]]))
						return id
					}),
				deleteRoute: (id) =>
					guard("deleteRoute").pipe(
						Effect.andThen(
							Ref.update(routes, (map) => new Map(Arr.filter([...map], ([key]) => key !== id))),
						),
					),
			}
			return {
				api,
				hostnames: Ref.get(hostnames),
				routes: Ref.get(routes),
				/** What Cloudflare would answer next for this hostname id. */
				setHostname: (id: string, patch: Partial<Omit<CustomHostnameState, "id" | "hostname">>) =>
					Ref.update(hostnames, (map) => {
						const current = map.get(id)
						return current === undefined ? map : new Map([...map, [id, { ...current, ...patch }]])
					}),
				/** Removes a hostname behind Maple's back, as a dashboard edit would. */
				dropHostname: (id: string) =>
					Ref.update(hostnames, (map) => new Map(Arr.filter([...map], ([key]) => key !== id))),
				setFailing: (value: boolean) => Ref.set(failing, value),
			}
		})
}
