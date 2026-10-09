import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Array as Arr, Effect, Option, Redacted, Schema } from "effect"
import {
	InternalScrapeTarget,
	ScrapeIntervalSeconds,
	ScrapeResultReportList,
	ScrapeTargetId,
	ScrapeTargetType,
	UserId,
} from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { isValidInternalBearer } from "@maple/backend/services/auth/internal-auth"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import {
	PlanetScaleDiscoveryService,
	type PlanetScaleSubTarget,
} from "@maple/backend/services/integrations/PlanetScaleDiscoveryService"
import type { ScrapeTargetRow } from "@maple/db/tables"
import { ScrapeTargetsService } from "@maple/backend/services/integrations/ScrapeTargetsService"

const decodeTargetIdSync = Schema.decodeUnknownSync(ScrapeTargetId)
const decodeScrapeIntervalSecondsSync = Schema.decodeUnknownSync(ScrapeIntervalSeconds)
const decodeTargetTypeSync = Schema.decodeUnknownSync(ScrapeTargetType)

/** Audit identity for lazily-created ingest keys (org_ingest_keys.created_by). */
const SCRAPER_SYSTEM_USER = Schema.decodeSync(UserId)("system-prometheus-scraper")
const decodeScrapeResultsEffect = Schema.decodeUnknownEffect(ScrapeResultReportList)
const decodeLabelsEffect = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))
const EMPTY_LABELS = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))({})
/** PlanetScale's data plane authenticates with the signed URL, never a header. */
const NO_AUTH_HEADERS: Record<string, string> = {}
const NO_SUB_TARGETS: ReadonlyArray<PlanetScaleSubTarget> = []
const NO_TARGETS: ReadonlyArray<InternalScrapeTarget> = []
/**
 * Rows resolved at once. Stays under the 5-connection invocation pool and caps
 * concurrent PlanetScale discovery GETs (each cached per target for 10 minutes).
 */
const ROW_CONCURRENCY = 4

const errorText = (message: string, status: number) =>
	HttpServerResponse.text(message, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	})

export interface ScrapeTargetRowLike {
	readonly id: string
	readonly orgId: string
	readonly name: string
	readonly serviceName: string | null
	readonly url: string
	readonly targetType: string
	readonly scrapeIntervalSeconds: number
	readonly labelsJson: unknown
}

export interface SubTargetOverride {
	/** Discovered per-branch scrape URL replacing the row's SD endpoint url. */
	readonly url: string
	/** `url` plus the signed `?sig=&exp=` params the data plane authenticates with. */
	readonly signedUrl: string
	readonly subTargetKey: string
	/** Discovery labels; the target's own labelsJson wins on key conflicts. */
	readonly labels: Record<string, string>
}

class InvalidScrapeTargetRow extends Schema.TaggedError<InvalidScrapeTargetRow>()(
	"@maple/api/routes/InvalidScrapeTargetRow",
	{
		message: Schema.String,
		rawTargetId: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Marshal a DB row into the internal wire shape. Unparseable labels degrade
 * to `{}`; a row that fails the schema brands (interval out of range, bad id,
 * unknown target type) yields `none` so one corrupt row cannot break the whole
 * list. `authHeaders` is the row's already-decrypted Authorization header (or
 * `{}`); discovered sub-targets (PlanetScale branches) pass an override
 * carrying the concrete scrape URL, its signed form, and the discriminator key.
 */
export const toInternalScrapeTarget = (
	row: ScrapeTargetRowLike,
	ingestKey: string,
	authHeaders: Record<string, string>,
	subTarget?: SubTargetOverride,
): Effect.Effect<Option.Option<InternalScrapeTarget>> =>
	Effect.gen(function* () {
		const ownLabels = row.labelsJson
			? yield* decodeLabelsEffect(row.labelsJson).pipe(Effect.orElseSucceed(() => EMPTY_LABELS))
			: EMPTY_LABELS
		const labels = subTarget ? { ...subTarget.labels, ...ownLabels } : ownLabels
		return yield* Effect.try({
			try: () =>
				new InternalScrapeTarget({
					id: decodeTargetIdSync(row.id),
					orgId: row.orgId,
					name: row.name,
					serviceName: row.serviceName ?? null,
					targetType: decodeTargetTypeSync(row.targetType),
					url: subTarget?.url ?? row.url,
					scrapeUrl: subTarget?.signedUrl ?? row.url,
					authHeaders,
					subTargetKey: subTarget?.subTargetKey ?? null,
					scrapeIntervalSeconds: decodeScrapeIntervalSecondsSync(row.scrapeIntervalSeconds),
					labels,
					ingestKey,
				}),
			catch: (cause) =>
				new InvalidScrapeTargetRow({
					message: "Invalid scrape target row",
					rawTargetId: row.id,
					cause,
				}),
		}).pipe(Effect.option)
	})

const logSkip = (message: string, row: ScrapeTargetRowLike, annotations: Record<string, unknown> = {}) =>
	Effect.logWarning(message).pipe(
		Effect.annotateLogs({ scrapeTargetId: row.id, orgId: row.orgId, ...annotations }),
	)

/** Runs `onNone` (the skip log) when a row fails the schema brands. */
const warnIfNone =
	(onNone: () => Effect.Effect<void>) =>
	<A>(target: Option.Option<A>): Effect.Effect<void> =>
		Option.isNone(target) ? onNone() : Effect.void

/**
 * Internal endpoints backing the standalone Prometheus scraper
 * (apps/scraper). The scraper polls `/api/internal/scrape-targets` for the
 * enabled target list — each entry carries the concrete URL to fetch and the
 * decrypted Authorization header for it, so the master encryption key and the
 * PlanetScale OAuth grant never leave the API — scrapes every target itself,
 * and reports outcomes to `/api/internal/scrape-results`.
 */
export const ScraperInternalRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const service = yield* ScrapeTargetsService
		const ingestKeys = yield* OrgIngestKeysService
		const discovery = yield* PlanetScaleDiscoveryService
		const internalToken = Option.match(env.SD_INTERNAL_TOKEN, {
			onNone: () => undefined,
			onSome: Redacted.value,
		})

		const unauthorized = (req: HttpServerRequest.HttpServerRequest) => {
			if (!internalToken) return errorText("Scraper internal endpoints are not configured", 401)
			if (!isValidInternalBearer(req.headers.authorization, internalToken)) {
				return errorText("Unauthorized", 401)
			}
			return undefined
		}

		// Expand the logical target into its discovered per-branch endpoints.
		// Discovery failure with no cache skips the row this round; the scheduler
		// re-fetches the list every reconcile.
		const planetScaleTargets = (row: ScrapeTargetRow, ingestKey: string) =>
			discovery.discover(row).pipe(
				Effect.catch((error) =>
					logSkip("Skipping PlanetScale target (discovery failed)", row, {
						error: error.message,
					}).pipe(Effect.as(NO_SUB_TARGETS)),
				),
				Effect.flatMap((subTargets) =>
					Effect.forEach(subTargets, (subTarget) =>
						toInternalScrapeTarget(row, ingestKey, NO_AUTH_HEADERS, subTarget).pipe(
							Effect.tap(
								warnIfNone(() =>
									logSkip("Skipping scrape sub-target (invalid row)", row, {
										subTargetKey: subTarget.subTargetKey,
									}),
								),
							),
						),
					),
				),
				Effect.map(Arr.getSomes),
			)

		// A credential that no longer decrypts (rotated master key, corrupt row)
		// skips this target for the round rather than failing the whole list; the
		// target's own `lastScrapeError` already tells the org.
		const directTargets = (row: ScrapeTargetRow, ingestKey: string) =>
			service.authHeaders(row).pipe(
				Effect.flatMap((authHeaders) => toInternalScrapeTarget(row, ingestKey, authHeaders)),
				Effect.tap(warnIfNone(() => logSkip("Skipping scrape target (invalid row)", row))),
				Effect.map(Option.toArray),
				Effect.catch((error) =>
					logSkip("Skipping scrape target (credentials unavailable)", row, {
						error: error.message,
					}).pipe(Effect.as(NO_TARGETS)),
				),
			)

		const resolveRowTargets = (row: ScrapeTargetRow, ingestKey: string) =>
			row.targetType === "planetscale"
				? planetScaleTargets(row, ingestKey)
				: directTargets(row, ingestKey)

		const listTargets = Effect.fn("ScraperInternal.listTargets")(
			function* (req: HttpServerRequest.HttpServerRequest) {
				const denied = unauthorized(req)
				if (denied) return denied

				const rows = yield* service.listAllEnabled()

				// One public ingest key per org (lazily created on first use, like
				// onboarding does). The scraper ingests with this key so scraped
				// metrics are billed and warehouse-routed identically to the org's
				// own OTLP traffic. Resolved for every org in one batch.
				const keysByOrg = yield* ingestKeys.getOrCreateMany(
					rows.map((row) => row.orgId),
					SCRAPER_SYSTEM_USER,
				)

				// Rows are independent; most of the cost is one PlanetScale discovery
				// GET per uncached row, so run them side by side, bounded.
				const perRow = yield* Effect.forEach(
					rows,
					(row) =>
						Option.match(Option.fromNullishOr(keysByOrg.get(row.orgId)), {
							onNone: () =>
								logSkip("Skipping scrape target (no ingest key)", row).pipe(
									Effect.as(NO_TARGETS),
								),
							onSome: (keys) => resolveRowTargets(row, keys.publicKey),
						}),
					{ concurrency: ROW_CONCURRENCY },
				)

				return yield* HttpServerResponse.json(Arr.flatten(perRow))
			},
			Effect.catch((error) =>
				Effect.logError("Failed to build scraper target list").pipe(
					Effect.annotateLogs({ error: error.message }),
					Effect.as(errorText("Scraper target list unavailable", 503)),
				),
			),
		)

		const recordResults = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const denied = unauthorized(req)
				if (denied) return denied

				const body = yield* req.json.pipe(Effect.option)
				if (Option.isNone(body)) return errorText("Invalid JSON body", 400)

				const results = yield* decodeScrapeResultsEffect(body.value).pipe(Effect.option)
				if (Option.isNone(results)) return errorText("Invalid scrape results payload", 400)

				yield* service.recordScrapeResults(results.value)

				return yield* HttpServerResponse.json({ recorded: results.value.length })
			}).pipe(
				Effect.catch((error) =>
					Effect.logError("Failed to persist scrape results").pipe(
						Effect.annotateLogs({ error: error.message }),
						Effect.as(errorText("Scrape result persistence unavailable", 503)),
					),
				),
				// No wrapper span: everything measurable here happens inside
				// `ScrapeTargetsService.recordScrapeResults`, and the two spans were
				// byte-identical in duration (8,065/day each at 546.8ms avg) on the
				// second-busiest route in the service. The `http.server POST` span
				// already bounds the request.
			)

		yield* router.add("GET", "/api/internal/scrape-targets", listTargets)
		yield* router.add("POST", "/api/internal/scrape-results", recordResults)
	}),
)
