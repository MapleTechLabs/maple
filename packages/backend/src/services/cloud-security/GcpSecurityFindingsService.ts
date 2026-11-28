/**
 * Reads every security-enabled GCP connector's Security Command Center findings into
 * `CloudSecurityStore`. Maple signs in as its own account and impersonates the connector's reader,
 * which holds `roles/securitycenter.findingsViewer` on the scope; no customer credential is kept.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { type GcpConnectorRow, GcpConnectors } from "@maple/db/tables"
import { CLOUD_SECURITY_PUSH_ALIVE_MS, type CloudServiceState } from "@maple/domain/cloud-security"
import { gcpScopeParent } from "@maple/domain/gcp"
import type { IntegrationsPersistenceError } from "@maple/domain/http"
import { IntegrationsPersistenceError as PersistenceError } from "@maple/domain/http"
import { GcpServiceAccountKey } from "@maple/infra/secrets"
import { GcpLocation } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import {
	fetchMapleAccessToken,
	type GcpApiError,
	importServiceAccountKey,
	impersonateReader,
	listSccFindingsPage,
} from "../integrations/gcp/api"
import { pollFleet } from "../integrations/poll-fleet"
import { NOT_ENABLED_RECHECK_MS, PUSHED_POLL_MS } from "./AwsSecurityFindingsService"
import { CLOSED_FINDING_RETENTION_MS, type CloudFindingWrite, CloudSecurityStore } from "./CloudSecurityStore"
import { readSccFinding } from "./scc-findings"

/** Every active finding is listed each poll: the ones missing from a complete listing closed. */
const ACTIVE_FILTER = 'state="ACTIVE"'
/** Pages one connector reads per poll; past it the listing is incomplete and nothing is resolved. */
const MAX_PAGES = 20
const CONNECTOR_CONCURRENCY = 2
/** A tick stops starting connectors after this long, inside its lane's budget. */
const TICK_BUDGET_MS = 200 * 1000
const GLOBAL = Schema.decodeSync(GcpLocation)("global")
const SOURCE = "security_command_center"

const toPersistenceError = makePersistenceErrorMapper(
	PersistenceError,
	"GCP security connectors are unavailable",
)

export interface GcpSecurityPollSummary {
	readonly connectors: number
	readonly failedConnectors: number
	readonly findings: number
	readonly resolved: number
}

const IDLE: GcpSecurityPollSummary = { connectors: 0, failedConnectors: 0, findings: 0, resolved: 0 }

/** How a failed read leaves the feed. A refused call is the role or the API, not an outage. */
export const sccStateOfError = (error: GcpApiError): CloudServiceState => {
	if (error.reason === "SERVICE_DISABLED") return "not_enabled"
	if (error.kind === "denied") return "denied"
	// SCC not activated for the scope answers FAILED_PRECONDITION / NOT_FOUND.
	if (error.kind === "invalid" || error.kind === "not_found") return "not_enabled"
	return "failing"
}

interface FeedState {
	readonly state: CloudServiceState
	readonly checkedAt: number
	readonly pushedAt: number | null
}

/** Whether a connector's feed is due: never read, or older than its state allows. */
export const sccFeedDue = (state: FeedState | undefined, now: number, pollEveryMs: number): boolean => {
	if (state === undefined) return true
	const age = now - state.checkedAt
	if (state.state === "not_enabled" || state.state === "denied") return age >= NOT_ENABLED_RECHECK_MS
	// Notifications arrive as they happen; the poll is only for what one missed.
	if (state.pushedAt !== null && now - state.pushedAt < CLOUD_SECURITY_PUSH_ALIVE_MS)
		return age >= PUSHED_POLL_MS
	return age >= pollEveryMs
}

/** A feed without pushes is read on every tick of its lane (every five minutes). */
const POLL_EVERY_MS = 4 * 60 * 1000

export interface GcpSecurityFindingsServiceApi {
	/** No-op unless `MAPLE_GCP_SERVICE_ACCOUNT_KEY` is set. */
	readonly pollAll: Effect.Effect<GcpSecurityPollSummary, IntegrationsPersistenceError>
}

interface ConnectorPoll {
	readonly failed: boolean
	readonly findings: number
	readonly resolved: number
}

export class GcpSecurityFindingsService extends Context.Service<
	GcpSecurityFindingsService,
	GcpSecurityFindingsServiceApi
>()("@maple/backend/services/GcpSecurityFindingsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "GcpSecurityFindingsService", toPersistenceError)
		const store = yield* CloudSecurityStore
		const featureFlags = yield* OrganizationFeatureFlagsService
		const httpClient = yield* HttpClient.HttpClient
		const serviceAccountKey = yield* GcpServiceAccountKey

		const pollConnector = Effect.fn("GcpSecurityFindingsService.pollConnector")(function* (
			row: GcpConnectorRow,
			mapleToken: Effect.Success<ReturnType<typeof fetchMapleAccessToken>>,
			now: number,
		) {
			yield* Effect.annotateCurrentSpan({
				"tenant.orgId": row.orgId,
				"maple.gcp.connector_id": row.id,
				"maple.gcp.scope_type": row.scopeType,
			})
			const feed = {
				orgId: row.orgId,
				provider: "gcp" as const,
				connectionId: row.id,
				region: GLOBAL,
				source: SOURCE,
			} as const
			const record = (state: CloudServiceState, cursorAt: number | null, lastError: string | null) =>
				Effect.flatMap(Clock.currentTimeMillis, (checkedAt) =>
					store.recordServiceState({
						...feed,
						state,
						cursorAt,
						windowMs: null,
						lastError,
						checkedAt,
					}),
				)
			const parent = gcpScopeParent(row.scopeType, row.scopeId)
			// What a push stores after this is newer than the listing: resolving stops here.
			const readStartedAt = yield* Clock.currentTimeMillis
			interface Listing {
				readonly results: ReadonlyArray<unknown>
				readonly complete: boolean
			}
			const listing = yield* Effect.result(
				Effect.gen(function* () {
					const reader = yield* impersonateReader(httpClient, mapleToken, row)
					const page = (
						token: string | undefined,
						left: number,
						seen: ReadonlyArray<unknown>,
					): Effect.Effect<Listing, GcpApiError> =>
						listSccFindingsPage(httpClient, reader, parent, ACTIVE_FILTER, token).pipe(
							Effect.flatMap((body) => {
								const results = Arr.appendAll(seen, body.listFindingsResults ?? [])
								if (body.nextPageToken === undefined || body.nextPageToken === "")
									return Effect.succeed({ results, complete: true })
								return left <= 1
									? Effect.succeed({ results, complete: false })
									: page(body.nextPageToken, left - 1, results)
							}),
						)
					return yield* page(undefined, MAX_PAGES, [])
				}),
			)
			if (listing._tag === "Failure") {
				const state = sccStateOfError(listing.failure)
				yield* Effect.annotateCurrentSpan({ "maple.cloud_security.state": state })
				yield* record(state, null, listing.failure.message)
				return { failed: state === "failing", findings: 0, resolved: 0 } satisfies ConnectorPoll
			}
			const { results, complete } = listing.success
			const writes: ReadonlyArray<CloudFindingWrite> = Arr.flatMap(results, (raw) =>
				Option.toArray(
					Option.map(readSccFinding(raw, row.scopeId, now), (read) => ({
						...read.finding,
						orgId: row.orgId,
						provider: "gcp" as const,
						connectionId: row.id,
						accountId: read.accountId,
						region: read.region,
						source: SOURCE,
					})),
				),
			)
			const syncedAt = yield* Clock.currentTimeMillis
			yield* store.upsertFindings(writes, syncedAt)
			// Only a whole listing says what closed; a cut one leaves the rest to the next poll.
			const resolved = complete
				? yield* store.resolve(
						feed,
						{
							except: Arr.map(
								Arr.filter(writes, (write) => write.region === GLOBAL),
								(write) => write.findingId,
							),
						},
						readStartedAt,
					)
				: 0
			yield* store.pruneClosed(row.orgId, now - CLOSED_FINDING_RETENTION_MS)
			const cursorAt = Arr.reduce(writes, 0, (max, write) => Math.max(max, write.providerUpdatedAt))
			yield* record(
				"enabled",
				cursorAt === 0 ? null : cursorAt,
				complete ? null : `Read the first ${MAX_PAGES} pages only.`,
			)
			yield* Effect.annotateCurrentSpan({
				"maple.cloud_security.findings": writes.length,
				"maple.cloud_security.resolved": resolved,
				"maple.cloud_security.complete": complete,
			})
			return { failed: false, findings: writes.length, resolved } satisfies ConnectorPoll
		})

		const pollAll = Effect.gen(function* () {
			if (Option.isNone(serviceAccountKey)) return IDLE
			const now = yield* Clock.currentTimeMillis
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(GcpConnectors)
						.select()
						.where(($) => [$.securityEnabled.eq(true)]),
				),
			)
			const due = yield* Effect.filter(
				rows,
				(row) =>
					Effect.gen(function* () {
						const flags = yield* featureFlags.flags(row.orgId)
						if (!flags.cloudSecurity) return false
						const states = yield* store.serviceStates(row.orgId, row.id)
						const state = Arr.findFirst(states, (s) => s.source === SOURCE && s.region === GLOBAL)
						return sccFeedDue(Option.getOrUndefined(state), now, POLL_EVERY_MS)
					}),
				{ concurrency: CONNECTOR_CONCURRENCY },
			)
			yield* Effect.annotateCurrentSpan({
				"maple.gcp.security_connectors": rows.length,
				"maple.gcp.security_due": due.length,
			})
			if (due.length === 0) return IDLE
			const signer = yield* importServiceAccountKey(serviceAccountKey.value)
			const mapleToken = yield* fetchMapleAccessToken(httpClient, signer, now)
			const polls = yield* pollFleet(
				due,
				(row) =>
					Effect.gen(function* () {
						if ((yield* Clock.currentTimeMillis) - now >= TICK_BUDGET_MS) return null
						return yield* pollConnector(row, mapleToken, now)
					}),
				{
					message: "GCP security poll failed",
					annotations: (row) => ({ orgId: row.orgId, connectorId: row.id }),
					fallback: (): ConnectorPoll => ({ failed: true, findings: 0, resolved: 0 }),
				},
				CONNECTOR_CONCURRENCY,
			)
			const done = Arr.filter(polls, (poll) => poll !== null)
			return {
				connectors: done.length,
				failedConnectors: Arr.filter(done, (poll) => poll.failed).length,
				findings: Arr.reduce(done, 0, (sum, poll) => sum + poll.findings),
				resolved: Arr.reduce(done, 0, (sum, poll) => sum + poll.resolved),
			} satisfies GcpSecurityPollSummary
		}).pipe(
			// Maple's own sign-in failing is a deployment problem: logged, and the tick reports idle.
			Effect.catchTag("@maple/api/integrations/GcpApiError", (error) =>
				Effect.logError("GCP security poll could not sign in").pipe(
					Effect.annotateLogs({ error: error.message }),
					Effect.as(IDLE),
				),
			),
			Effect.withSpan("GcpSecurityFindingsService.pollAll"),
		)

		return { pollAll } satisfies GcpSecurityFindingsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide([
			CloudSecurityStore.layer,
			OrganizationFeatureFlagsService.layer,
			FetchHttpClient.layer,
		]),
	)
}
