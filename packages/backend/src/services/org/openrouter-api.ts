/**
 * The two OpenRouter calls the key check makes, shaped like a `@distilled.cloud` SDK: a
 * credentials service resolved per request, a REST protocol, and operations whose failures are
 * typed per HTTP status. OpenRouter's error body is `{ error: { code, message } }`.
 */
import * as API from "@distilled.cloud/core/api"
import * as Category from "@distilled.cloud/core/category"
import { makeRestProtocol } from "@distilled.cloud/core/protocol-rest"
import * as T from "@distilled.cloud/core/trait"
import { Context, Effect, Predicate, Redacted, Schema } from "effect"

export const OPENROUTER_API_URLS = {
	us: "https://openrouter.ai/api/v1",
	eu: "https://eu.openrouter.ai/api/v1",
} as const

export interface Config {
	readonly apiKey: Redacted.Redacted<string>
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
	credentials: Effect.gen(function* () {
		return yield* Credentials
	}),
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
