/** The sandbox Worker's secret env, read from the deploy's environment. */
import * as Secrets from "@maple/infra/secrets"

// Never the shared `INTERNAL_SERVICE_TOKEN` (acts as any org; this runs model-chosen commands).
// Required so a missing token fails the deploy, not every call.
export const sandboxSecrets = Secrets.SandboxInternalServiceToken.required
