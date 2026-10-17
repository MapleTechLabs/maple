import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import type { Etag, HttpPlatform } from "effect/http"
import type { FileSystem, Path } from "effect"
import { MapleAiApi, MapleApi, MapleInternalApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import type { Dataset, EndpointHandler } from "../fixtures/dataset.ts"
import type { CallLog } from "./call-log.ts"
import { middlewareContext, type DatasetOf } from "./middleware.ts"

/**
 * The four HttpApis the web app calls, served by the real `HttpApiBuilder` route machinery so
 * requests decode and responses encode exactly as they do against `apps/api`. Every endpoint gets
 * the same generic handler: dataset override, then default, else a 501 recorded as unmocked.
 */
const APIS = [MapleApi, MapleInternalApi, MapleAiApi, MapleApiV2] as const

type FixtureApi = (typeof APIS)[number]

/** The parts of an endpoint the generic handler reads; every `HttpApiEndpoint` has them. */
export interface ReflectedEndpoint {
	readonly identifier: string
	readonly method: string
	readonly path: string
	readonly success: ReadonlySet<Schema.Top>
}

export interface ReflectedGroup {
	readonly identifier: string
	readonly endpoints: Readonly<Record<string, ReflectedEndpoint>>
}

interface ReflectedApi {
	readonly api: FixtureApi
	readonly groups: ReadonlyArray<ReflectedGroup>
}

interface ReflectedHandlers {
	readonly handle: (
		identifier: string,
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- reflected over every endpoint: the request is per-endpoint wire data, decoded by HandlerRequest
		handler: (request: unknown) => Effect.Effect<unknown, unknown, HttpRouter.Provided>,
	) => ReflectedHandlers
}

const reflect = (api: FixtureApi): ReflectedApi => {
	const groups: Readonly<Record<string, ReflectedGroup>> = api.groups
	return { api, groups: Object.values(groups) }
}

/**
 * Registering every endpoint of four APIs from one loop is reflection: the per-endpoint types the
 * builder tracks cannot be restated for a group chosen at runtime, so its generic signatures are
 * erased here (and only here). Runtime behavior is the real builder's.
 */
// SAFETY: same runtime function; `group` only needs the API value, a group id it declares, and handlers for its endpoints.
const builderGroup = HttpApiBuilder.group as unknown as (
	api: FixtureApi,
	identifier: string,
	build: (handlers: ReflectedHandlers) => ReflectedHandlers,
) => Layer.Layer<never>
// SAFETY: same runtime function; the group services it reads are provided by `builderGroup` layers below.
const builderLayer = HttpApiBuilder.layer as unknown as (
	api: FixtureApi,
) => Layer.Layer<never, never, HttpRouter.HttpRouter | Etag.Generator | FileSystem.FileSystem | HttpPlatform.HttpPlatform | Path.Path>

export const FIXTURE_APIS: ReadonlyArray<ReflectedApi> = APIS.map(reflect)

/** The endpoint tag the call log and dataset handlers use. */
export const endpointTag = (group: ReflectedGroup, endpoint: ReflectedEndpoint) =>
	`${group.identifier}.${endpoint.identifier}`

export interface ApiServerOptions {
	readonly datasetOf: DatasetOf
	readonly captureOf: (request: HttpServerRequest.HttpServerRequest) => string | null
	readonly calls: CallLog
	/** Dataset override first, then the generic default; `undefined` = unmocked. */
	readonly handlerFor: (dataset: Dataset, tag: string) => EndpointHandler | undefined
	/** Endpoints whose call-log entries the handler writes itself (execute-batch logs each query). */
	readonly selfLogging: ReadonlySet<string>
}

const Json = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownOption(Json)

/** The request as it crossed the wire: route params, query string and JSON body. */
const wireRequest = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest
	const route = yield* HttpRouter.RouteContext
	const url = new URL(request.url, "http://parity.local")
	const text = request.method === "GET" || request.method === "HEAD" ? "" : yield* request.text
	const body = text.length === 0 ? undefined : Option.getOrElse(decodeJson(text), () => text)
	return {
		...(Object.keys(route.params).length === 0 ? undefined : { params: route.params }),
		...(url.search.length === 0 ? undefined : { query: Object.fromEntries(url.searchParams) }),
		...(body === undefined ? undefined : { body }),
	}
})

/** The decoded parts of a handler request the fixtures read; their contents stay wire JSON. */
const HandlerRequest = Schema.Struct({
	payload: Schema.optionalKey(Schema.Unknown),
	params: Schema.optionalKey(Schema.Unknown),
	query: Schema.optionalKey(Schema.Unknown),
})
const decodeHandlerRequest = Schema.decodeUnknownOption(HandlerRequest)
const NO_PARTS = Schema.decodeUnknownSync(HandlerRequest)({})

const unmockedResponse = (tag: string) =>
	HttpServerResponse.jsonUnsafe(
		{ _tag: "@maple/ui-parity/Unmocked", message: `ui-parity: no fixture handler for ${tag}` },
		{ status: 501 },
	)

/** Fixtures are written in wire form; decoding them with the success schema checks them too. */
const successDecoder = (endpoint: ReflectedEndpoint) => {
	const schemas = [...endpoint.success]
	const [only, ...rest] = schemas
	const schema = only !== undefined && rest.length === 0 ? only : Schema.Union(schemas)
	// SAFETY: @maple/domain success schemas need no decoding services; `Top` only widens R to unknown.
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the decoder's input is the fixture's wire JSON by definition
	return Schema.decodeUnknownEffect(schema) as (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>
}

const genericHandler = (options: ApiServerOptions, group: ReflectedGroup, endpoint: ReflectedEndpoint) => {
	const tag = endpointTag(group, endpoint)
	const decodeSuccess = successDecoder(endpoint)
	const logged = !options.selfLogging.has(tag)
	return (request: unknown) =>
		Effect.gen(function* () {
			const http = yield* HttpServerRequest.HttpServerRequest
			const dataset = options.datasetOf(http)
			const capture = options.captureOf(http)
			const respond = options.handlerFor(dataset, tag)
			if (respond === undefined) {
				options.calls.recordUnmocked(capture, `${tag} (${endpoint.method} ${endpoint.path})`)
				return unmockedResponse(tag)
			}
			if (logged) options.calls.record(capture, tag, yield* wireRequest)
			const parts = Option.getOrElse(decodeHandlerRequest(request), () => NO_PARTS)
			const answer = respond({
				dataset,
				payload: parts.payload,
				params: parts.params,
				query: parts.query,
				record: (entryTag, payload) => options.calls.record(capture, entryTag, payload),
			})
			return yield* decodeSuccess(yield* answer).pipe(
				Effect.catch((error) => {
					options.calls.recordUnmocked(capture, `invalid-fixture:${tag}: ${error.message}`)
					return Effect.succeed(
						HttpServerResponse.jsonUnsafe(
							{ _tag: "@maple/ui-parity/InvalidFixture", message: `${tag}: ${error.message}` },
							{ status: 500 },
						),
					)
				}),
			)
		})
}

/** One API's groups, each endpoint on the generic handler, registered with the shared router. */
const apiLayer = (reflected: ReflectedApi, options: ApiServerOptions) =>
	builderLayer(reflected.api).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.empty,
				...reflected.groups.map((group) =>
					builderGroup(reflected.api, group.identifier, (handlers) =>
						Object.values(group.endpoints).reduce(
							(acc, endpoint) => acc.handle(endpoint.identifier, genericHandler(options, group, endpoint)),
							handlers,
						),
					),
				),
			),
		),
	)

/** All endpoints of the four APIs as routes, plus a catch-all that reports anything else. */
export const makeApiWebHandler = (options: ApiServerOptions) => {
	const middleware = middlewareContext(options.datasetOf, (request, description) =>
		options.calls.recordUnmocked(options.captureOf(request), description),
	)
	const notFound = HttpRouter.add(
		"*",
		"*",
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest
			const path = new URL(request.url, "http://parity.local").pathname
			options.calls.recordUnmocked(options.captureOf(request), `${request.method} ${path} (no such route)`)
			return unmockedResponse(`${request.method} ${path}`)
		}),
	)
	const app = Layer.mergeAll(notFound, ...FIXTURE_APIS.map((api) => apiLayer(api, options))).pipe(
		Layer.provide(Layer.succeedContext(middleware)),
		Layer.provide(HttpServer.layerServices),
	)
	return HttpRouter.toWebHandler(app, { disableLogger: true })
}

/** Every `"<group>.<endpoint>"` the four APIs declare, for coverage reports and tests. */
export const allEndpointTags = (): ReadonlyArray<string> =>
	FIXTURE_APIS.flatMap((api) =>
		api.groups.flatMap((group) => Object.values(group.endpoints).map((endpoint) => endpointTag(group, endpoint))),
	)
