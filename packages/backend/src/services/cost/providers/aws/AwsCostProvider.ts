/**
 * AWS as a cost provider: daily cost of a connected account, from Cost Explorer. Maple assumes the
 * connection's role with its own OIDC token and keeps no credential.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { AwsConnections } from "@maple/db/tables"
import { awsConnectionResourceNames, awsOidcIssuer, awsOidcSubject, awsRoleArn } from "@maple/domain/aws"
import { AwsConnectionId } from "@maple/primitives"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { type AwsApiError, assumeRole } from "../../../integrations/aws/api"
import { type AwsOidcSigner, makeAwsOidcSigner } from "../../../integrations/aws/oidc"
import {
	type CostProviderAdapter,
	CostProviderError,
	type CostPull,
	type CostPullSource,
	type CostPullWindow,
} from "../../CostProvider"

// Cost Explorer's SDK module is large: it loads with the first pull, not with the Worker.
const costExplorer = Effect.promise(() => import("./cost-explorer"))

type Reason = CostProviderError["reason"]

/** A failure before Cost Explorer was asked anything: no request was billed. */
const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "aws", reason, requests: 0 })

const noConnection = () => failed("auth", "No such AWS connection.")

// A role that cannot be assumed is the connection's problem; a throttled or failing STS is not.
const assumeReason = (kind: AwsApiError["kind"]): Reason =>
	kind === "throttled" ? "rate_limited" : kind === "upstream" ? "upstream" : "auth"

export class AwsCostProvider extends Context.Service<AwsCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/AwsCostProvider",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const dbExecute = makeDbExecute(database, "AwsCostProvider", () =>
				failed("upstream", "AWS connection database error"),
			)

			// Without a usable key no role can be assumed: every pull fails as `auth`.
			const signer: AwsOidcSigner | undefined = yield* Option.match(env.MAPLE_AWS_OIDC_SIGNING_KEY, {
				onNone: () => Effect.undefined,
				onSome: (key) =>
					makeAwsOidcSigner(awsOidcIssuer(env.MAPLE_API_BASE_URL), key).pipe(
						Effect.catchTag("@maple/backend/integrations/AwsOidcKeyError", (error) =>
							Effect.logWarning(`AWS cost disabled: ${error.message}`).pipe(
								Effect.as(undefined),
							),
						),
					),
			})

			const pull = Effect.fn("AwsCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "aws",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					if (signer === undefined) {
						return yield* failed("auth", "AWS cannot be connected on this Maple deployment.")
					}
					const connectionId = Schema.decodeOption(AwsConnectionId)(source.connectionRef)
					if (Option.isNone(connectionId)) return yield* noConnection()
					// By org as well as id: a source never reads another org's connection.
					const [row] = yield* dbExecute((db) =>
						db.run(
							PG.from(AwsConnections)
								.select()
								.where(($) => [$.orgId.eq(source.orgId), $.id.eq(connectionId.value)])
								.limit(1),
						),
					)
					if (row === undefined) return yield* noConnection()

					const names = awsConnectionResourceNames(row.id)
					const token = yield* Clock.currentTimeMillis.pipe(
						Effect.flatMap((issuedAt) => signer.mint(awsOidcSubject(row.id), issuedAt)),
						Effect.mapError((error) => failed("auth", error.message)),
					)
					const session = yield* assumeRole(httpClient, token, {
						roleArn: awsRoleArn(row.accountId, names.roleName),
						roleName: names.roleName,
						sessionName: names.sessionName,
					}).pipe(Effect.mapError((error) => failed(assumeReason(error.kind), error.message)))

					const { pullCostExplorer } = yield* costExplorer
					const pulled = yield* pullCostExplorer(httpClient, session, row.accountId, window)
					yield* Effect.annotateCurrentSpan({
						"maple.cost.requests": pulled.requests,
						"maple.cost.rows": pulled.rows.length,
						"maple.cost.aws.detailed_regions": pulled.detailedRegions.length,
						"maple.cost.aws.unreconciled_regions": pulled.unreconciledRegions,
					})
					return { rows: pulled.rows, requests: pulled.requests } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({
						"maple.cost.requests": error.requests,
						"maple.cost.error_reason": error.reason,
					}),
				),
			)

			return { provider: "aws", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
