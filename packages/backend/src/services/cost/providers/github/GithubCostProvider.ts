/**
 * GitHub as a cost provider: an organization's daily billed usage by product, SKU and repository,
 * from the billing usage report, read with the GitHub App installation the org already has.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { VcsInstallations } from "@maple/db/tables"
import { VcsInstallationId } from "@maple/domain/vcs"
import { Clock, Context, Duration, Effect, Layer, Option, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { VcsProviderRegistry } from "../../../integrations/vcs/VcsProviderRegistry"
import type { CostProviderAdapter, CostPull, CostPullSource, CostPullWindow } from "../../CostProvider"
import { addDays, utcToday } from "../../sync-plan"
import { failed, monthsOfWindow, readUsageMonth } from "./billing-usage"
import { toCostRows } from "./normalize"

// A short rate limit is waited out inside the client, so a pull can take a while to answer.
const PULL_TIMEOUT = Duration.seconds(90)

const noInstallation = () => failed("auth", "The GitHub organization of this source is not connected.")

export class GithubCostProvider extends Context.Service<GithubCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/GithubCostProvider",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const registry = yield* VcsProviderRegistry
			// The registry always has GitHub: a miss is a broken build, not a pull's failure.
			const github = yield* Effect.orDie(registry.resolve("github"))
			const dbExecute = makeDbExecute(database, "GithubCostProvider", () =>
				failed("upstream", "GitHub installation database error"),
			)

			const pull = Effect.fn("GithubCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "github",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					const installationId = Schema.decodeOption(VcsInstallationId)(source.connectionRef)
					if (Option.isNone(installationId)) return yield* noInstallation()
					// By org as well as id: a source never reads through another org's installation.
					const [installation] = yield* dbExecute((db) =>
						db.run(
							PG.from(VcsInstallations)
								.select(($) => ({
									externalInstallationId: $.externalInstallationId,
									accountLogin: $.accountLogin,
								}))
								.where(($) => [
									$.orgId.eq(source.orgId),
									$.id.eq(installationId.value),
									$.provider.eq("github"),
									$.status.eq("active"),
									$.accountType.eq("organization"),
								])
								.limit(1),
						),
					)
					if (installation === undefined) return yield* noInstallation()
					const months = monthsOfWindow(window)
					const items = yield* Effect.forEach(months, (month) =>
						readUsageMonth(github, installation, month),
					).pipe(
						Effect.timeoutOrElse({
							duration: PULL_TIMEOUT,
							orElse: () => Effect.fail(failed("upstream", "GitHub took too long to answer.")),
						}),
					)
					// Usage keeps arriving for a day or two: today and yesterday can still change.
					const now = yield* Clock.currentTimeMillis
					const openDay = addDays(utcToday(now), -1)
					const rows = toCostRows(Arr.flatten(items), installation.accountLogin, window, openDay)
					yield* Effect.annotateCurrentSpan({
						"maple.cost.rows": rows.length,
						"maple.cost.github.months": months.length,
					})
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "github", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(VcsProviderRegistry.layer))
}
