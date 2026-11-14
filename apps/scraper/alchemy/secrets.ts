/** The secrets the scraper task stores in Secrets Manager, read from the deploy's environment. */
import * as Config from "effect/Config"
import * as Secrets from "@maple/infra/secrets"

export const scraperSecrets = Config.all({
	internalToken: Secrets.ScraperInternalToken.value,
	otelIngestKey: Secrets.OtelIngestKey.value,
})
