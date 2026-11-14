/**
 * Holds the secret catalog exact: every deployable reads the secrets `@maple/infra/secrets` grants
 * it, no more (the deploy's guard already refuses those) and no fewer (a grant nothing reads).
 * Each row names the config its stack file resolves. A deployable without a row does not compile.
 */
import { expect, test } from "vitest"
import type * as Config from "effect/Config"
import { Array as Arr, ConfigProvider, Effect, Order, Record as Rec } from "effect"
import { managedDbSecrets, type MapleStage, workersObservabilitySecrets } from "@maple/infra/cloudflare"
import { selfObservabilityEnv } from "@maple/infra/env"
import type { SecretConsumer } from "@maple/infra/secret"
import { resolveAs } from "@maple/infra/secret-guard"
import * as Catalog from "@maple/infra/secrets"
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

const catalog = Rec.values(Catalog)
const catalogKeys = new Set<string>(Arr.map(catalog, (secret) => secret.envKey))

const grantedTo = (consumer: SecretConsumer) =>
	Arr.sort(
		Arr.map(
			Arr.filter(catalog, (secret) => secret.meta.consumers.includes(consumer)),
			(secret) => secret.envKey,
		),
		Order.String,
	)

/**
 * The catalog secrets `config` reads through the deploy's own `resolveAs`, set in the environment
 * or not: every key is answered, and a read the catalog denies throws.
 */
const secretsRead = (consumer: SecretConsumer, config: Config.Config<unknown>) => {
	const read = new Set<string>()
	// "1" parses as a string, a number and a boolean, so a typed var beside a secret still resolves.
	const answersEverything = ConfigProvider.make((path) =>
		Effect.sync(() => {
			const key = Arr.join(Arr.map(path, String), "_")
			if (catalogKeys.has(key)) read.add(key)
			return ConfigProvider.makeValue("1")
		}),
	)
	Effect.runSync(
		Effect.provideService(resolveAs(consumer, config), ConfigProvider.ConfigProvider, answersEverything),
	)
	return Arr.fromIterable(read)
}

const STAGES: ReadonlyArray<MapleStage> = [
	{ kind: "prd" },
	{ kind: "pr", prNumber: 1 },
	{ kind: "dev", name: "dev" },
]

/** A secret bound on only some stages is still a grant, so each config is read on all three. */
const onEveryStage = (config: (stage: MapleStage) => Config.Config<unknown>) => Arr.map(STAGES, config)

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
		const read = Arr.flatMap(configs, (config) => secretsRead(consumer, config))
		expect(Arr.sort(Arr.dedupe(read), Order.String)).toEqual(grantedTo(consumer))
	},
)

test("a deployable is refused a secret the catalog grants only to others", () => {
	expect(() => secretsRead("landing", Catalog.StripeSecretKey.required)).toThrow(
		"landing may not read STRIPE_SECRET_KEY",
	)
})

test("api binds the preview sign-in key on a PR preview and on no other stage", () => {
	const readsIt = (stage: MapleStage) =>
		secretsRead("api", apiConfiguredEnv(stage, "us", {})).includes("PREVIEW_SIGNIN_KEY")
	expect(Arr.map(STAGES, readsIt)).toEqual([false, true, false])
})
