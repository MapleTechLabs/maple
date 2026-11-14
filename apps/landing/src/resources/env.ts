/** Secrets the landing build reads server-side: the pricing table and the star count. */
import { merge } from "@maple/infra/env"
import * as Secrets from "@maple/infra/secrets"

export const landingBuildSecrets = merge(Secrets.AutumnSecretKey.optional, Secrets.GithubToken.optional)
