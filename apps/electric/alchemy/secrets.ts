/** The secret the Electric task stores in Secrets Manager, read from the deploy's environment. */
import * as Secrets from "@maple/infra/secrets"

// Shared with the electric-sync Worker; rotate by redeploying Electric first, then the Worker.
export const electricSecrets = Secrets.ElectricSecret.requiredValue
