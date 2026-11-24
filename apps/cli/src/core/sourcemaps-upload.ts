import { Array as Arr, Effect, Option, Result, Schema, String as Str } from "effect"
import { FileSystem } from "effect/FileSystem"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { sendTraced } from "../commands/api"
import { errorMessageOf, parseJson } from "./api-request"
import { existingDebugId, findJsFiles, mapDebugId, MAX_MAP_BYTES, SourceMapsFileError } from "./sourcemaps"

/** One map the workspace refused, or that never reached it (no `status`). */
export class SourceMapUploadError extends Schema.TaggedError<SourceMapUploadError>()(
	"@maple/cli/SourceMapUploadError",
	{
		message: Schema.String,
		minifiedPath: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export interface UploadOptions {
	readonly apiUrl: string
	readonly token: string
	readonly service: Option.Option<string>
	readonly version: Option.Option<string>
	readonly urlPrefix: Option.Option<string>
	/** Parallel uploads; the command uses 4. */
	readonly concurrency: number
}

export type UploadOutcome =
	| {
			readonly _tag: "uploaded"
			readonly minifiedPath: string
			readonly debugId: Option.Option<string>
			readonly sizeBytes: number
			readonly id: Option.Option<string>
	  }
	| { readonly _tag: "skipped"; readonly minifiedPath: string; readonly reason: string }
	| { readonly _tag: "failed"; readonly minifiedPath: string; readonly error: SourceMapUploadError }

/** The JS file's path on the deploy, `--url-prefix` first, never with a leading slash. */
export const minifiedPathFor = (urlPrefix: Option.Option<string>, file: string): string => {
	const prefix = Option.getOrElse(urlPrefix, () => "")
	const joined = prefix === "" || Str.endsWith("/")(prefix) ? `${prefix}${file}` : `${prefix}/${file}`
	return Str.replace(/^(?:~\/|\/)+/, "")(joined)
}

/** The query string for one upload: debug id, service and version only when known. */
export const uploadParams = (input: {
	readonly minifiedPath: string
	readonly debugId: Option.Option<string>
	readonly service: Option.Option<string>
	readonly version: Option.Option<string>
}): ReadonlyArray<readonly [string, string]> => [
	["minified_path", input.minifiedPath],
	...Option.toArray(Option.map(input.debugId, (id) => ["debug_id", id] as const)),
	...Option.toArray(Option.map(input.service, (s) => ["service", s] as const)),
	...Option.toArray(Option.map(input.version, (v) => ["version", v] as const)),
]

const IdField = Schema.Struct({ id: Schema.String })

const send = (
	options: UploadOptions,
	params: ReadonlyArray<readonly [string, string]>,
	minifiedPath: string,
	body: Uint8Array,
) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const url = new URL(`${Str.replace(/\/+$/, "")(options.apiUrl)}/v2/source_maps`)
		const request = HttpClientRequest.post(url.toString()).pipe(
			HttpClientRequest.setUrlParams(params),
			HttpClientRequest.setHeader("accept", "application/json"),
			HttpClientRequest.bearerToken(options.token),
			HttpClientRequest.bodyUint8Array(body, "application/json"),
		)
		const response = yield* sendTraced(client, request, url).pipe(
			Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
			Effect.mapError(
				(cause) =>
					new SourceMapUploadError({
						message: `could not reach ${url.origin}`,
						minifiedPath,
						cause,
					}),
			),
		)
		const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
		const json = text === "" ? Option.none() : Result.getSuccess(parseJson(text, "the response"))
		if (response.status >= 200 && response.status < 300)
			return Option.map(
				Option.flatMap(json, (u) => Result.getSuccess(Schema.decodeUnknownResult(IdField)(u))),
				(o) => o.id,
			)
		const detail = Option.getOrElse(Option.flatMap(json, errorMessageOf), () =>
			Str.trim(text) === "" ? "no message" : Str.slice(0, 300)(Str.trim(text)),
		)
		return yield* new SourceMapUploadError({
			message: `HTTP ${response.status}: ${detail}`,
			minifiedPath,
			status: response.status,
		})
	})

/**
 * Upload every map below `dir` whose JS file is there too. `onOutcome` runs as each file finishes,
 * so progress prints while the rest are still uploading.
 */
export const uploadDirectory = (
	dir: string,
	options: UploadOptions,
	onOutcome: (outcome: UploadOutcome) => Effect.Effect<void>,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const files = yield* findJsFiles(dir)
		const pairs = Arr.flatMap(files, (js) =>
			Option.toArray(Option.map(js.mapPath, (mapPath) => ({ js, mapPath }))),
		)
		// Two JS files naming one map upload it once, under the first path.
		const withMaps = Arr.dedupeWith(pairs, (a, b) => a.mapPath === b.mapPath)
		return yield* Effect.forEach(
			withMaps,
			({ js, mapPath }) =>
				Effect.gen(function* () {
					const minifiedPath = minifiedPathFor(options.urlPrefix, js.file)
					const info = yield* fs.stat(mapPath).pipe(
						Effect.mapError(
							(cause) =>
								new SourceMapsFileError({
									message: `could not read ${mapPath}`,
									path: mapPath,
									cause,
								}),
						),
					)
					if (info.size > BigInt(MAX_MAP_BYTES))
						return {
							_tag: "skipped",
							minifiedPath,
							reason: `map is over ${MAX_MAP_BYTES / 1024 / 1024} MiB`,
						} satisfies UploadOutcome
					const body = yield* fs.readFile(mapPath).pipe(
						Effect.mapError(
							(cause) =>
								new SourceMapsFileError({
									message: `could not read ${mapPath}`,
									path: mapPath,
									cause,
								}),
						),
					)
					const debugId = Option.orElse(mapDebugId(new TextDecoder().decode(body)), () =>
						existingDebugId(js.code),
					)
					if (
						Option.isNone(debugId) &&
						(Option.isNone(options.service) || Option.isNone(options.version))
					)
						return {
							_tag: "skipped",
							minifiedPath,
							reason: "no debug id; run `maple sourcemaps inject` first, or pass --service and --release",
						} satisfies UploadOutcome
					const params = uploadParams({
						minifiedPath,
						debugId,
						service: options.service,
						version: options.version,
					})
					return yield* send(options, params, minifiedPath, body).pipe(
						Effect.map((id): UploadOutcome => ({
							_tag: "uploaded",
							minifiedPath,
							debugId,
							sizeBytes: body.byteLength,
							id,
						})),
						Effect.catchTag("@maple/cli/SourceMapUploadError", (error) =>
							Effect.succeed<UploadOutcome>({ _tag: "failed", minifiedPath, error }),
						),
					)
				}).pipe(Effect.tap(onOutcome)),
			{ concurrency: options.concurrency },
		)
	})
