import { DemoSeedError, DemoSeedResponse } from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import type { TenantContext } from "./AuthService"
import { DEMO_RELEASES, generateDemoRows } from "./demo/fixtures"
import { VcsRepository } from "./vcs/VcsRepository"

const DEMO_HOURS_DEFAULT = 6
const DEMO_RATE_PER_HOUR = 250
// Rows per warehouse append. Keeps each NDJSON POST body modest (~1.5k rows
// total for the 6h default) without fanning out into many tiny requests.
const INGEST_CHUNK = 500

// The synthetic GitHub installation/repo the demo "releases" belong to. Stable ids
// so re-seeding is idempotent (every upsert keys on these). The demo telemetry
// stamps these releases' SHAs on its spans, so the deploy markers on the demo
// service charts resolve to the commits seeded below.
const DEMO_INSTALLATION_ID = "demo-installation"
const DEMO_REPO_EXTERNAL_ID = "demo-repository"
const DEMO_REPO_OWNER = "maple-demo"
const DEMO_REPO_NAME = "demo-app"
const DEMO_REPO_FULL_NAME = `${DEMO_REPO_OWNER}/${DEMO_REPO_NAME}`
const DEMO_REPO_HTML_URL = `https://github.com/${DEMO_REPO_FULL_NAME}`

const chunk = <T>(rows: ReadonlyArray<T>, size: number): T[][] => {
	const out: T[][] = []
	for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
	return out
}

export class DemoService extends Context.Service<DemoService>()("@maple/api/services/DemoService", {
	make: Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const repo = yield* VcsRepository

		// Seed a demo GitHub installation + repo + commits matching the SHAs the demo
		// telemetry stamps on its spans, so each deploy marker's commit hover card
		// resolves (the "stored" fast path) to a real commit instead of "not found".
		// All upserts are idempotent, so re-seeding the demo just refreshes these rows.
		const seedReleaseCommits = Effect.fn("DemoService.seedReleaseCommits")(function* (
			tenant: TenantContext,
			hours: number,
		) {
			const now = yield* Clock.currentTimeMillis
			const windowMs = hours * 3600 * 1000

			const installation = yield* repo.upsertInstallation({
				orgId: tenant.orgId,
				provider: "github",
				externalInstallationId: DEMO_INSTALLATION_ID,
				accountLogin: DEMO_REPO_OWNER,
				accountType: "organization",
				externalAccountId: "demo-account",
				accountAvatarUrl: null,
				repositorySelection: "selected",
				installedByUserId: tenant.userId,
			})

			// Keep the demo installation OUT of the "active" set: the integration card
			// surfaces the org's active installation, and an active demo row would
			// compete with (and could shadow) a real connected repo. Marking it
			// disconnected leaves the integration card untouched while the demo commits
			// stay fully resolvable — the hover card's stored lookup is org-scoped by
			// SHA and doesn't care about installation status.
			yield* repo.markInstallationStatus(installation.id, "disconnected")

			yield* repo.upsertRepositories(installation, [
				{
					externalRepoId: DEMO_REPO_EXTERNAL_ID,
					owner: DEMO_REPO_OWNER,
					name: DEMO_REPO_NAME,
					fullName: DEMO_REPO_FULL_NAME,
					defaultBranch: "main",
					htmlUrl: DEMO_REPO_HTML_URL,
					isPrivate: false,
					isArchived: false,
				},
			])

			const repository = yield* repo.resolveRepository(tenant.orgId, "github", DEMO_REPO_EXTERNAL_ID)
			if (Option.isNone(repository)) {
				return yield* new DemoSeedError({ message: "Demo repository missing after upsert" })
			}

			yield* repo.upsertCommits(
				repository.value,
				DEMO_RELEASES.map((release) => {
					// Each release "lands" at its fraction of the seeded window — matching
					// where the deploy marker shows on the chart's time axis.
					const committedAt = now - windowMs + Math.floor(release.from * windowMs)
					return {
						sha: release.sha,
						message: release.message,
						authorName: release.authorName,
						authorEmail: release.authorEmail,
						authorLogin: release.authorLogin,
						authorAvatarUrl: null,
						authoredAt: committedAt,
						committedAt,
						htmlUrl: `${DEMO_REPO_HTML_URL}/commit/${release.sha}`,
					}
				}),
			)
		})

		const seed = Effect.fn("DemoService.seed")(function* (
			tenant: TenantContext,
			hours: number = DEMO_HOURS_DEFAULT,
		) {
			const safeHours = Math.max(1, Math.min(24, Math.floor(hours)))
			const { traceRows, logRows } = generateDemoRows({
				orgId: tenant.orgId,
				hours: safeHours,
				ratePerHour: DEMO_RATE_PER_HOUR,
			})

			const ingestAll = (datasource: "traces" | "logs", rows: ReadonlyArray<unknown>) =>
				Effect.forEach(
					chunk(rows, INGEST_CHUNK),
					(batch) =>
						warehouse
							.ingest(tenant, datasource, batch)
							.pipe(Effect.mapError((error) => new DemoSeedError({ message: error.message }))),
					{ concurrency: 1, discard: true },
				)

			// Write straight to the warehouse datasources, bypassing the
			// billing-enforced ingest gateway (which 402s brand-new orgs that have
			// no active subscription — the whole point of demo data is to work
			// before the user has picked a plan).
			yield* ingestAll("traces", traceRows)
			yield* ingestAll("logs", logRows)

			// Best-effort: the deploy markers render from telemetry alone, so a failure
			// here (e.g. the local D1 VCS tables aren't migrated yet) must not fail the
			// whole seed — it only costs the markers their resolved commit hover cards.
			yield* seedReleaseCommits(tenant, safeHours).pipe(
				Effect.catch((error) =>
					Effect.logWarning("Demo VCS commit seed skipped").pipe(
						Effect.annotateLogs({ error: error.message }),
					),
				),
			)

			return new DemoSeedResponse({
				seeded: true,
				skippedReason: null,
				spansSent: traceRows.length,
				logsSent: logRows.length,
				metricsSent: 0,
			})
		})

		return { seed }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
