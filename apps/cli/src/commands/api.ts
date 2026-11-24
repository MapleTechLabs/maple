import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import {
	Array as Arr,
	Effect,
	Option,
	Record as Rec,
	Redacted,
	Result,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { FileSystem } from "effect/FileSystem"
import { Stdio } from "effect/Stdio"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpTraceContext } from "effect/http"
import { MapleConfig } from "../core/config"
import {
	API_METHODS,
	type ApiMethod,
	buildBody,
	errorMessageOf,
	parseField,
	parseHeader,
	parseJson,
	resolveApiPath,
	sendsBody,
	withQuery,
} from "../core/api-request"
import { CliUsageError } from "../lib/errors"
import { encodeJson } from "@maple/local-server/json"
import { printJson } from "../lib/output"

/** The workspace answered a raw API request with a non-2xx status. */
export class ApiResponseError extends Schema.TaggedError<ApiResponseError>()("@maple/cli/ApiResponseError", {
	status: Schema.Number,
	message: Schema.String,
	hint: Schema.optionalKey(Schema.String),
}) {}

/** The request never got an answer (DNS, TLS, connection refused). */
export class ApiTransportError extends Schema.TaggedError<ApiTransportError>()(
	"@maple/cli/ApiTransportError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/**
 * Send under our own client span. The built-in one closes `Error` on every 4xx, but here a 4xx
 * answers the person's own request; the root span already tells a 4xx from a 5xx.
 */
export const sendTraced = (
	client: HttpClient.HttpClient,
	request: HttpClientRequest.HttpClientRequest,
	url: URL,
) =>
	Effect.useSpan(
		request.method,
		{
			kind: "client",
			attributes: {
				"http.request.method": request.method,
				"server.address": url.hostname,
				"url.path": url.pathname,
			},
		},
		(span) =>
			client.execute(HttpClientRequest.setHeaders(request, HttpTraceContext.toHeaders(span))).pipe(
				Effect.tap((response) =>
					Effect.sync(() => span.attribute("http.response.status_code", response.status)),
				),
				Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
			),
	)

const pathArg = Argument.String("path").pipe(
	Argument.withDescription("API path on the logged-in workspace, e.g. /v2/services or /api/dashboards"),
)

const requestFlags = {
	data: Flag.String("data").pipe(
		Flag.withAlias("d"),
		Flag.withDescription(
			"Request field, repeatable: key=value (string), key:=<json> (number, boolean, array), " +
				"nested with brackets (metadata[team]=core, ids[]=a). Query string for GET/DELETE, JSON body otherwise",
		),
		Flag.atLeast(0),
	),
	header: Flag.String("header").pipe(
		Flag.withAlias("H"),
		Flag.withDescription('Extra request header, repeatable: -H "Idempotency-Key: abc"'),
		Flag.atLeast(0),
	),
	input: Flag.optional(
		Flag.String("input").pipe(
			Flag.withDescription(
				"Raw JSON request body from a file, or - for standard input (instead of -d)",
			),
		),
	),
	include: Flag.Boolean("include").pipe(
		Flag.withAlias("i"),
		Flag.withDescription("Print the response status and headers to stderr"),
		Flag.withDefault(false),
	),
}

interface RequestInput {
	readonly path: string
	readonly data: ReadonlyArray<string>
	readonly header: ReadonlyArray<string>
	readonly input: Option.Option<string>
	readonly include: boolean
}

const readAllStdin = Effect.gen(function* () {
	const stdio = yield* Stdio
	return yield* Stream.decodeText(stdio.stdin).pipe(Stream.mkString)
}).pipe(
	Effect.mapError(
		() => new CliUsageError({ message: "could not read the request body from standard input" }),
	),
)

const readInput = (source: string): Effect.Effect<string, CliUsageError, FileSystem | Stdio> =>
	source === "-"
		? readAllStdin
		: Effect.flatMap(FileSystem, (fs) => fs.readFileString(source)).pipe(
				Effect.mapError(() => new CliUsageError({ message: `could not read --input ${source}` })),
			)

/** The logged-in workspace; raw API calls never go to a local server. */
const remoteTarget = Effect.gen(function* () {
	if (Arr.some(process.argv, (arg) => arg === "--local" || /^--local=(?!false$)/.test(arg)))
		return yield* new CliUsageError({
			message: "raw API requests go to a remote workspace; --local is not supported",
			hint: "drop --local",
		})
	const config = yield* MapleConfig
	const target = Option.all({ apiUrl: config.apiUrl, token: config.token })
	if (Option.isNone(target))
		return yield* new CliUsageError({
			message: "not logged in to a Maple workspace",
			hint: "run `maple login`, or set MAPLE_API_URL and MAPLE_API_TOKEN",
		})
	return { apiUrl: target.value.apiUrl, token: Redacted.value(target.value.token) }
})

const runRequest = Effect.fnUntraced(function* (method: ApiMethod, a: RequestInput) {
	const { apiUrl, token } = yield* remoteTarget
	const baseUrl = yield* Effect.fromResult(resolveApiPath(apiUrl, a.path))
	const fields = yield* Effect.forEach(a.data, (raw) => Effect.fromResult(parseField(raw)))
	const headers = yield* Effect.forEach(a.header, (raw) => Effect.fromResult(parseHeader(raw)))
	if (Arr.some(headers, ([name]) => Str.toLowerCase(name) === "authorization"))
		return yield* new CliUsageError({
			message: "-H authorization is not allowed; the stored login supplies it",
			hint: "set MAPLE_API_TOKEN to use a different token",
		})

	if (Option.isSome(a.input) && !sendsBody(method))
		return yield* new CliUsageError({ message: `--input is a request body, and ${method} sends none` })
	if (Option.isSome(a.input) && fields.length > 0)
		return yield* new CliUsageError({ message: "pass either --input or -d fields, not both" })

	const body = yield* Option.match(a.input, {
		onSome: (source) =>
			readInput(source).pipe(
				Effect.flatMap((text) => Effect.fromResult(parseJson(text, `--input ${source}`))),
				Effect.asSome,
			),
		onNone: () =>
			sendsBody(method) && fields.length > 0
				? Effect.asSome(Effect.fromResult(buildBody(fields)))
				: Effect.succeedNone,
	})
	const url = sendsBody(method) ? baseUrl : withQuery(baseUrl, fields)

	const request = HttpClientRequest.make(method)(url.toString()).pipe(
		HttpClientRequest.setHeader("accept", "application/json"),
		HttpClientRequest.setHeaders(Rec.fromEntries(headers)),
		HttpClientRequest.bearerToken(token),
		(req) =>
			Option.match(body, {
				onNone: () => req,
				onSome: (json) => HttpClientRequest.bodyText(req, encodeJson(json), "application/json"),
			}),
	)

	const client = yield* HttpClient.HttpClient
	// A redirect is the endpoint's answer: report it, never follow it to another page.
	const response = yield* sendTraced(client, request, url).pipe(
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		Effect.mapError(
			(cause) => new ApiTransportError({ message: `could not reach ${url.origin}`, cause }),
		),
	)
	if (a.include) {
		yield* Effect.sync(() => {
			process.stderr.write(`HTTP ${response.status}\n`)
			Arr.forEach(Rec.toEntries(response.headers), ([name, value]) =>
				process.stderr.write(`${name}: ${String(value)}\n`),
			)
			process.stderr.write("\n")
		})
	}

	const ok = response.status >= 200 && response.status < 300
	// Server-sent events stay open while they arrive, so pass them through as they come.
	if (ok && Str.includes("text/event-stream")(response.headers["content-type"] ?? "")) {
		return yield* response.stream.pipe(
			Stream.runForEach((chunk) => Effect.sync(() => process.stdout.write(chunk))),
			Effect.mapError(
				(cause) =>
					new ApiTransportError({ message: `the event stream from ${url.origin} broke`, cause }),
			),
		)
	}

	// A body that breaks mid-read is a failure, never an empty success; an empty 204 reads as "".
	const text = yield* response.text.pipe(
		Effect.mapError(
			(cause) =>
				new ApiTransportError({ message: `the response from ${url.origin} was cut off`, cause }),
		),
	)
	// JSON is pretty-printed; anything else (or an empty 204) is passed through as-is.
	const json = text === "" ? Option.none() : Result.getSuccess(parseJson(text, "the response"))
	if (Option.isSome(json)) yield* printJson(json.value)
	else if (text !== "")
		yield* Effect.sync(() => process.stdout.write(Str.endsWith("\n")(text) ? text : `${text}\n`))

	if (!ok) {
		const detail = Option.getOrElse(
			Option.flatMap(json, errorMessageOf).pipe(Option.map((m) => `: ${m}`)),
			() => "",
		)
		const message = `${method} ${url.pathname} returned HTTP ${response.status}${detail}`
		return yield* response.status === 401
			? new ApiResponseError({ status: 401, message, hint: "run `maple login` again" })
			: new ApiResponseError({ status: response.status, message })
	}
})

const methodCommand = (method: Exclude<ApiMethod, "DELETE">) =>
	Command.make(Str.toLowerCase(method), { path: pathArg, ...requestFlags }).pipe(
		Command.withDescription(
			`Send a ${method} request to any Maple API endpoint as the logged-in user and print the JSON response`,
		),
		Command.withHandler((a) => runRequest(method, a)),
	)

export const get = methodCommand("GET")
export const post = methodCommand("POST")
export const put = methodCommand("PUT")
export const patch = methodCommand("PATCH")

const METHOD_CHOICES = Arr.flatMap(API_METHODS, (m) => [[m, m] as const, [Str.toLowerCase(m), m] as const])

/** `maple api <method> <path>`: any method, including DELETE (`maple delete` removes local data). */
export const api = Command.make("api", {
	method: Argument.ChoiceWithValue("method", METHOD_CHOICES).pipe(
		Argument.withDescription("HTTP method: GET, POST, PUT, PATCH or DELETE"),
	),
	path: pathArg,
	...requestFlags,
}).pipe(
	Command.withDescription("Send a request with any method to any Maple API endpoint as the logged-in user"),
	Command.withHandler((a) => runRequest(a.method, a)),
)
