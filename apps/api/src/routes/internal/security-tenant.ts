import { CurrentTenant, DependencyScanForbiddenError } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Effect } from "effect"

/** The caller's tenant, once they hold `security:manage`: the Security Center is for engineers and admins. */
export const securityTenant = Effect.tap(CurrentTenant.Context, (tenant) =>
	Policy.check(
		tenant.roles,
		"security:manage",
		(denial) => new DependencyScanForbiddenError({ message: denial.message }),
	),
)
