/**
 * Holds the secret catalog exact: every deployable reads the secrets `@maple/infra/secrets` grants
 * it, no more (the deploy's guard already refuses those) and no fewer (a grant nothing reads).
 * Each row names the config its stack file resolves. A deployable without a row does not compile.
 */
import { expect, test } from "vitest"
import type * as Config from "effect/Config"
import { Array as Arr, Effect, Order, Record as Rec } from "effect"
import { managedDbSecrets, type MapleStage, workersObservabilitySecrets } from "@maple/infra/cloudflare"
import { selfObservabilityEnv } from "@maple/infra/env"
import type { SecretConsumer } from "@maple/infra/secret"
import { grantedTo, secretsReadBy } from "@maple/infra/secret-guard"
import { aiConfiguredEnv } from "../../apps/ai/src/resources/env.ts"
import { alertingConfiguredEnv } from "../../apps/alerting/src/resources/env.ts"
import { apiConfiguredEnv } from "../../apps/api/src/resources/env.ts"
import { chatBotConfiguredEnv } from "../../apps/chat-bot/src/resources/env.ts"
import { electricSecrets } from "../../apps/electric/alchemy/secrets.ts"
import { electricSyncConfiguredEnv } from "../../apps/electric-sync/src/resources/env.ts"
import { ingestPgUrl, ingestSecrets } from "../../apps/ingest/alchemy/secrets.ts"
import { landingBuildSecrets } from "../../apps/landing/src/resources/env.ts"
import { sandboxSecrets } from "../../apps/sandbox/alchemy/secrets.ts"
import { scraperSecrets } from "../../apps/scraper/alchemy/secrets.ts"

/** A secret bound on only some stages is still a grant, so each config is read on all three. */
const onEveryStage = <A>(config: (stage: MapleStage) => Config.Config<A>) =>
	Arr.map<ReadonlyArray<MapleStage>, Config.Config<unknown>>(
		[{ kind: "prd" }, { kind: "pr", prNumber: 1 }, { kind: "dev", name: "dev" }],
		config,
	)

const DEPLOYABLES = {
	api: onEveryStage((stage) => apiConfiguredEnv(stage, "us", {})),
	// With and without a sandbox Worker: its token is bound only where one deploys.
	ai: Arr.flatMap([true, false], (sandbox) =>
		onEveryStage((stage) => aiConfiguredEnv({ stage, region: "us", domains: {}, sandbox })),
	),
	alerting: onEveryStage((stage) => alertingConfiguredEnv(stage, "us", {})),
	"chat-bot": onEveryStage((stage) =>
		chatBotConfiguredEnv({ stage, region: "us", webOrigin: "https://app.maple.dev" }),
	),
	"electric-sync": onEveryStage((stage) => electricSyncConfiguredEnv(stage, "us", {})),
	sandbox: [sandboxSecrets],
	status: onEveryStage((stage) => selfObservabilityEnv(stage, "us")),
	web: onEveryStage((stage) => selfObservabilityEnv(stage, "us")),
	landing: [landingBuildSecrets],
	ingest: [ingestSecrets, ingestPgUrl],
	scraper: [scraperSecrets],
	electric: [electricSecrets],
	"workers-observability": [workersObservabilitySecrets],
	"managed-db": [managedDbSecrets],
} satisfies Record<SecretConsumer, ReadonlyArray<Config.Config<unknown>>>

test.each(Rec.toEntries(DEPLOYABLES))(
	"%s reads exactly the secrets the catalog grants it",
	(consumer, configs) => {
		const read = Arr.flatMap(configs, (config) => Effect.runSync(secretsReadBy(consumer, config)))
		expect(Arr.sort(Arr.dedupe(read), Order.String)).toEqual(grantedTo(consumer))
	},
)

test("api binds the preview sign-in key on a PR preview only", () => {
	const readOn = (stage: MapleStage) =>
		Effect.runSync(secretsReadBy("api", apiConfiguredEnv(stage, "us", {})))
	expect(readOn({ kind: "prd" })).not.toContain("PREVIEW_SIGNIN_KEY")
	expect(readOn({ kind: "pr", prNumber: 1 })).toContain("PREVIEW_SIGNIN_KEY")
})
