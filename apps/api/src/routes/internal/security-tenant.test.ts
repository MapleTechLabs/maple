import { describe, expect, it } from "@effect/vitest"
import { CurrentTenant, OrgId, RoleName, UserId } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { securityTenant } from "./security-tenant"

const tenantAs = (role: string) =>
	new CurrentTenant.TenantSchema({
		orgId: Schema.decodeSync(OrgId)("org_security"),
		userId: Schema.decodeSync(UserId)("user_security"),
		roles: [Schema.decodeSync(RoleName)(role)],
		authMode: "clerk",
	})

const resolveAs = (role: string) =>
	securityTenant.pipe(Effect.provideService(CurrentTenant.Context, tenantAs(role)), Effect.result)

describe("the Security Center's tenant", () => {
	it.effect("admits engineers and admins", () =>
		Effect.gen(function* () {
			expect((yield* resolveAs("org:engineer"))._tag).toBe("Success")
			expect((yield* resolveAs("org:admin"))._tag).toBe("Success")
		}),
	)

	it.effect("refuses members and analysts", () =>
		Effect.gen(function* () {
			const member = yield* resolveAs("org:member")
			const analyst = yield* resolveAs("org:analyst")
			expect([member._tag, analyst._tag]).toEqual(["Failure", "Failure"])
			if (member._tag === "Failure") {
				expect(member.failure._tag).toBe("@maple/http/dependency-scan/DependencyScanForbiddenError")
			}
		}),
	)
})
