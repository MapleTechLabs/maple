/**
 * The OpenRouter calls Maple makes outside an AI turn (the key checks and the cost pull), shaped
 * like a `@distilled.cloud` SDK: a credentials service resolved per request, a REST protocol, and
 * operations whose failures are typed per HTTP status. OpenRouter's error body is
 * `{ error: { code, message } }`.
 */
import * as API from "@distilled.cloud/core/api"
import * as Category from "@distilled.cloud/core/category"
import { makeRestProtocol } from "@distilled.cloud/core/protocol-rest"
import * as T from "@distilled.cloud/core/trait"
import { OPENROUTER_KEY_MAX_LENGTH } from "@maple/domain/http"
import { Context, Effect, Predicate, Redacted, Schema, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"

export const OPENROUTER_API_URLS = {
	us: "https://openrouter.ai/api/v1",
	eu: "https://eu.openrouter.ai/api/v1",
} as const

/**
 * Where a management key is used. OpenRouter documents its EU host for inference only, and an
 * account's activity is kept with its billing records, so every instance asks the global host.
 */
export const OPENROUTER_MANAGEMENT_API_URL = OPENROUTER_API_URLS.us

/** Whether the text has the shape of an OpenRouter key, so nothing else is ever sent to OpenRouter. */
export const isOpenRouterKey = (apiKey: string): boolean =>
	Str.startsWith("sk-or-")(apiKey) && apiKey.length >= 20 && apiKey.length <= OPENROUTER_KEY_MAX_LENGTH

export interface Config {
	readonly apiKey: Redacted.Redacted
	readonly apiBaseUrl: string
}

export class Credentials extends Context.Service<Credentials, Config>()(
	"@maple/backend/openrouter/Credentials",
) {}

/**
 * 400: OpenRouter refused the request as written. For a chat completion this includes a model the
 * key's own account settings cannot reach (provider keys, data region).
 */
export class BadRequest extends T.applyErrorMatchers(
	Schema.TaggedError<BadRequest>()("@maple/backend/openrouter/BadRequest", {
		message: Schema.String,
	}).pipe(Category.withBadRequestError),
	[{ status: 400 }],
) {}

/**
 * 404: no endpoint can serve the model, e.g. routing removed every in-region provider. The
 * message names each routing step and what it removed.
 */
export class NotFound extends T.applyErrorMatchers(
	Schema.TaggedError<NotFound>()("@maple/backend/openrouter/NotFound", {
		message: Schema.String,
	}).pipe(Category.withNotFoundError),
	[{ status: 404 }],
) {}

/** 401: the key is not a live OpenRouter key. */
export class Unauthorized extends T.applyErrorMatchers(
	Schema.TaggedError<Unauthorized>()("@maple/backend/openrouter/Unauthorized", {
		message: Schema.String,
	}).pipe(Category.withAuthError),
	[{ status: 401 }],
) {}

/** 402: the key's account is out of credits. */
export class PaymentRequired extends T.applyErrorMatchers(
	Schema.TaggedError<PaymentRequired>()("@maple/backend/openrouter/PaymentRequired", {
		message: Schema.String,
	}).pipe(Category.withQuotaError),
	[{ status: 402 }],
) {}

/** 403: the key is live but its plan may not make this call (e.g. the EU host on a lower plan). */
export class Forbidden extends T.applyErrorMatchers(
	Schema.TaggedError<Forbidden>()("@maple/backend/openrouter/Forbidden", {
		message: Schema.String,
	}).pipe(Category.withAuthError),
	[{ status: 403 }],
) {}

export class UnknownOpenRouterError extends Schema.TaggedError<UnknownOpenRouterError>()(
	"@maple/backend/openrouter/UnknownOpenRouterError",
	{ message: Schema.String, status: Schema.Number },
).pipe(Category.withServerError) {}

export class OpenRouterParseError extends Schema.TaggedError<OpenRouterParseError>()(
	"@maple/backend/openrouter/OpenRouterParseError",
	{ cause: Schema.Defect() },
).pipe(Category.withParseError) {}

const errorEnvelope = (body: unknown) => {
	if (!Predicate.isObject(body) || !Predicate.hasProperty(body, "error")) return undefined
	const error = body.error
	if (!Predicate.isObject(error)) return undefined
	return {
		code: Predicate.hasProperty(error, "code") && Predicate.isNumber(error.code) ? error.code : undefined,
		message:
			Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
				? error.message
				: undefined,
	}
}

const OpenRouterProtocol = makeRestProtocol<Config>({
	// Resolved per request on the calling fiber, so each call runs on the key it was given.
	// The SDK treats a bare service key as a service whose value is itself an Effect.
	credentials: Effect.suspend(() => Credentials),
	baseUrl: (credentials) => credentials.apiBaseUrl,
	headers: (credentials) => ({ Authorization: `Bearer ${Redacted.value(credentials.apiKey)}` }),
	errorEnvelope,
	unknownError: ({ status, message }) => new UnknownOpenRouterError({ status, message }),
	parseError: ({ cause }) => new OpenRouterParseError({ cause }),
})

const GetKeyRequest = Schema.Struct({}).pipe(T.Http({ method: "GET", uri: "/key", code: 200 }))

/** Who the key is. Answers 200 for any live key, whatever its plan. */
export const getKey = API.make(() => ({
	input: GetKeyRequest,
	output: Schema.Unknown,
	errors: [Unauthorized, Forbidden],
	protocol: OpenRouterProtocol,
}))

/**
 * What `GET /key` says about the key it was asked with. Either flag names a management key. An
 * organization's account is its `organization_id`; a personal one is the user who made the key.
 */
const KeyInfo = Schema.Struct({
	data: Schema.Struct({
		label: Schema.String,
		is_management_key: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
		is_provisioning_key: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
		organization_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
		creator_user_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	}),
})

// The SDK returns a 2xx body as it came, whatever `output` says, so a typed answer is decoded here.
const decoded =
	<A, I>(schema: Schema.Codec<A, I>) =>
	(body: unknown) =>
		Schema.decodeUnknownEffect(schema)(body).pipe(
			Effect.mapError((cause) => new OpenRouterParseError({ cause })),
		)

/** `getKey`, with the fields the cost source reads. */
export const getKeyInfo = (input: typeof GetKeyRequest.Type) =>
	getKey(input).pipe(Effect.flatMap(decoded(KeyInfo)))

/**
 * One day, model and serving endpoint of an account's spend. `usage` is USD billed by OpenRouter.
 * `date` starts with the UTC day, as a date or as a timestamp at its midnight.
 */
export const ActivityItem = Schema.Struct({
	date: Schema.String.check(
		Schema.isPattern(/^\d{4}-\d{2}-\d{2}/, { description: "Expected to start with YYYY-MM-DD" }),
	),
	model: Schema.String,
	provider_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	usage: Schema.Number,
	prompt_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	completion_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
})
export type ActivityItem = typeof ActivityItem.Type

const ActivityResponse = Schema.Struct({ data: Schema.Array(ActivityItem) })

const GetActivityRequest = Schema.Struct({}).pipe(T.Http({ method: "GET", uri: "/activity", code: 200 }))

const getActivityBody = API.make(() => ({
	input: GetActivityRequest,
	output: Schema.Unknown,
	errors: [BadRequest, Unauthorized, Forbidden],
	protocol: OpenRouterProtocol,
}))

/**
 * The account's last 30 completed UTC days, every day in one answer. Management keys only: any
 * other key gets 403.
 */
export const getActivity = (input: typeof GetActivityRequest.Type) =>
	getActivityBody(input).pipe(Effect.flatMap(decoded(ActivityResponse)))

const GetWorkspaceActivityRequest = Schema.Struct({
	workspaceId: Schema.String.pipe(T.Query("workspace_id")),
}).pipe(T.Http({ method: "GET", uri: "/activity", code: 200 }))

/**
 * One workspace's activity. A key for the whole account is answered 404 for a workspace the
 * account does not have; a key scoped to one workspace is answered 403 for any other.
 */
export const getWorkspaceActivity = API.make(() => ({
	input: GetWorkspaceActivityRequest,
	output: Schema.Unknown,
	errors: [BadRequest, Unauthorized, Forbidden, NotFound],
	protocol: OpenRouterProtocol,
}))

const CreateChatCompletionRequest = Schema.Struct({
	model: Schema.String,
	messages: Schema.Array(Schema.Struct({ role: Schema.Literal("user"), content: Schema.String })),
	max_tokens: Schema.Number,
}).pipe(T.Http({ method: "POST", uri: "/chat/completions", code: 200 }))

/** One non-streaming completion. */
export const createChatCompletion = API.make(() => ({
	input: CreateChatCompletionRequest,
	output: Schema.Unknown,
	errors: [BadRequest, Unauthorized, PaymentRequired, Forbidden, NotFound],
	protocol: OpenRouterProtocol,
}))

/** Every failure the operations above declare, plus transport errors. */
export type OpenRouterError = { readonly _tag: string; readonly message: string }

export const withCredentials = (config: Config) => Effect.provideService(Credentials, config)

/**
 * Runs OpenRouter calls on one key and host, over `httpClient`. A redirect is not OpenRouter
 * answering, so the key is never followed to another host.
 */
export const withKey =
	(httpClient: HttpClient.HttpClient, config: Config) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			withCredentials(config),
			Effect.provideService(HttpClient.HttpClient, httpClient),
			Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		)
