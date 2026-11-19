import { Config, Context, Effect, Layer, Option, Redacted, Schema, String as Str } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { OrgId } from "@maple/primitives"
import { WarehouseDeleteToken } from "@maple/infra/secrets"

/**
 * The warehouse's delete jobs, for erasing a deleted organization's rows from one datasource at a
 * time. Deletes are not SQL, so they cannot go through `WarehouseQueryService`: the warehouse runs
 * each as an asynchronous job, polled until done. Holds its own token, bound only to the eraser.
 */

export class WarehouseDeleteError extends Schema.TaggedError<WarehouseDeleteError>()(
	"@maple/backend/warehouse/WarehouseDeleteError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

export type WarehouseDeleteJobState =
	| { readonly _tag: "Pending" }
	| { readonly _tag: "Done" }
	| { readonly _tag: "Failed"; readonly message: string }

export interface WarehouseDeleteClientApi {
	/** Starts deleting `orgId`'s rows from `datasource`; answers the job id to poll. */
	readonly submit: (datasource: string, orgId: OrgId) => Effect.Effect<string, WarehouseDeleteError>
	readonly status: (jobId: string) => Effect.Effect<WarehouseDeleteJobState, WarehouseDeleteError>
}

// The condition is SQL the warehouse evaluates, so only plain identifiers reach it.
const SAFE_ORG_ID = /^[A-Za-z0-9_-]{1,128}$/
const SAFE_NAME = /^[a-z0-9_]{1,128}$/

/** The delete condition for one org, or `None` for an id that is not a plain identifier. */
export const orgDeleteCondition = (orgId: string): Option.Option<string> =>
	SAFE_ORG_ID.test(orgId) ? Option.some(`OrgId = '${orgId}'`) : Option.none()

const SubmitResponse = Schema.Struct({ job_id: Schema.String })
const JobResponse = Schema.Struct({ status: Schema.String, error: Schema.optionalKey(Schema.String) })

const PENDING = new Set(["waiting", "working"])

/** The `peer.service` registry name for the hosted warehouse (maple-telemetry-conventions). */
const PEER_SERVICE = "tinybird"

const refused = (message: string) => new WarehouseDeleteError({ message, cause: undefined })

export class WarehouseDeleteClient extends Context.Service<WarehouseDeleteClient, WarehouseDeleteClientApi>()(
	"@maple/backend/warehouse/WarehouseDeleteClient",
	{
		make: Effect.gen(function* () {
			const token = yield* WarehouseDeleteToken
			const host = yield* Config.option(Config.String("TINYBIRD_HOST"))
			const http = yield* HttpClient.HttpClient

			if (Option.isNone(token) || Option.isNone(host)) {
				// Unprovisioned: every call fails, so queued erasures wait with a reason instead of passing.
				const unprovisioned = Effect.fail(refused("The warehouse delete token is not provisioned"))
				return {
					submit: () => unprovisioned,
					status: () => unprovisioned,
				} satisfies WarehouseDeleteClientApi
			}
			const base = Str.replace(/\/+$/, "")(host.value)
			const bearer = Redacted.value(token.value)

			const requestFailed = (cause: unknown) =>
				new WarehouseDeleteError({ message: "Warehouse request failed", cause })

			/** The response body as JSON, or the warehouse's own words on a non-2xx answer. */
			const send = (request: HttpClientRequest.HttpClientRequest) =>
				http.execute(HttpClientRequest.bearerToken(request, bearer)).pipe(
					Effect.mapError(requestFailed),
					Effect.flatMap((response) =>
						response.status >= 200 && response.status < 300
							? response.json.pipe(Effect.mapError(requestFailed))
							: response.text.pipe(
									Effect.orElseSucceed(() => ""),
									Effect.flatMap((body) =>
										Effect.fail(
											refused(
												`Warehouse answered ${response.status}: ${Str.slice(0, 300)(body)}`,
											),
										),
									),
								),
					),
				)

			const decodeSubmit = Schema.decodeUnknownEffect(SubmitResponse)
			const decodeJob = Schema.decodeUnknownEffect(JobResponse)

			const submit = Effect.fn("WarehouseDeleteClient.submit")(function* (
				datasource: string,
				orgId: OrgId,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.warehouse.datasource": datasource,
					"peer.service": PEER_SERVICE,
				})
				if (!SAFE_NAME.test(datasource)) return yield* refused(`Not a datasource name: ${datasource}`)
				const condition = orgDeleteCondition(orgId)
				if (Option.isNone(condition)) return yield* refused("The org id is not a plain identifier")
				const job = yield* send(
					HttpClientRequest.post(`${base}/v0/datasources/${datasource}/delete`).pipe(
						HttpClientRequest.bodyUrlParams({ delete_condition: condition.value }),
					),
				).pipe(Effect.flatMap((body) => decodeSubmit(body).pipe(Effect.mapError(requestFailed))))
				return job.job_id
			})

			const status = Effect.fn("WarehouseDeleteClient.status")(function* (jobId: string) {
				yield* Effect.annotateCurrentSpan({
					"maple.warehouse.job_id": jobId,
					"peer.service": PEER_SERVICE,
				})
				const job = yield* send(
					HttpClientRequest.get(`${base}/v0/jobs/${encodeURIComponent(jobId)}`),
				).pipe(Effect.flatMap((body) => decodeJob(body).pipe(Effect.mapError(requestFailed))))
				const state: WarehouseDeleteJobState =
					job.status === "done"
						? { _tag: "Done" }
						: PENDING.has(job.status)
							? { _tag: "Pending" }
							: {
									_tag: "Failed",
									message: `Delete job ended "${job.status}"${job.error === undefined ? "" : `: ${job.error}`}`,
								}
				return state
			})

			return { submit, status } satisfies WarehouseDeleteClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
