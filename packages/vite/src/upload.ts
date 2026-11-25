import {
	type PlannedMap,
	planMaps,
	skipReason,
	type UploadTarget,
	uploadBody,
	uploadParams,
} from "@maple/sourcemaps"
import { Array as Arr, Duration, Effect, Option, Redacted, Schedule, Schema, String as Str } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

/** One map the Maple API refused, or that never reached it (no `status`). */
export class SourceMapUploadError extends Schema.TaggedError<SourceMapUploadError>()(
	"@maple-dev/vite/SourceMapUploadError",
	{
		message: Schema.String,
		minifiedPath: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export interface UploadConfig extends UploadTarget {
	readonly apiUrl: string
	readonly apiKey: Redacted.Redacted
}

export interface UploadSummary {
	readonly uploaded: number
	readonly skipped: ReadonlyArray<{ readonly minifiedPath: string; readonly reason: string }>
	readonly failed: ReadonlyArray<SourceMapUploadError>
}

const retryable = (error: SourceMapUploadError) =>
	error.status === undefined || error.status === 429 || error.status >= 500

const sendOne = (config: UploadConfig, map: PlannedMap) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const url = `${Str.replace(/\/+$/, "")(config.apiUrl)}/v2/source_maps`
		const request = HttpClientRequest.post(url).pipe(
			HttpClientRequest.setUrlParams(uploadParams(config, map)),
			HttpClientRequest.setHeader("accept", "application/json"),
			HttpClientRequest.bearerToken(Redacted.value(config.apiKey)),
			HttpClientRequest.bodyUint8Array(uploadBody(config, map), "application/json"),
		)
		const response = yield* client.execute(request).pipe(
			// A redirect would resend the key to another origin.
			Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
			Effect.mapError(
				(cause) =>
					new SourceMapUploadError({
						message: `could not reach ${config.apiUrl}`,
						minifiedPath: map.minifiedPath,
						cause,
					}),
			),
		)
		if (response.status >= 200 && response.status < 300) return
		const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
		const detail = Str.trim(text) === "" ? "no message" : Str.slice(0, 300)(Str.trim(text))
		return yield* new SourceMapUploadError({
			message: `HTTP ${response.status}: ${detail}`,
			minifiedPath: map.minifiedPath,
			status: response.status,
		})
	}).pipe(
		Effect.retry({
			while: retryable,
			schedule: Schedule.exponential(Duration.millis(500)),
			times: 4,
		}),
	)

/**
 * Uploads every map in `dir` through `POST /v2/source_maps`, four at a time. Maps that cannot be
 * used are skipped with a reason; one that fails after retries is reported, never thrown, so the
 * caller decides whether a failed upload fails the build.
 */
export const uploadSourceMaps = (dir: string, config: UploadConfig) =>
	Effect.gen(function* () {
		const maps = yield* planMaps(dir, config.urlPrefix)
		const skipped = Arr.getSomes(
			Arr.map(maps, (map) =>
				Option.map(skipReason(config, map), (reason) => ({ minifiedPath: map.minifiedPath, reason })),
			),
		)
		const sendable = Arr.filter(maps, (map) => Option.isNone(skipReason(config, map)))
		const results = yield* Effect.forEach(sendable, (map) => Effect.result(sendOne(config, map)), {
			concurrency: 4,
		})
		const failed = Arr.getFailures(results)
		return {
			uploaded: results.length - failed.length,
			skipped,
			failed,
		} satisfies UploadSummary
	})
