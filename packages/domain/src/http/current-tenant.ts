import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import { Schema, Context as EffectContext } from "effect"
import { AuthMode, OrgId, RoleName, UserId } from "../primitives"

export class UnauthorizedError extends Schema.TaggedErrorClass<UnauthorizedError>()(
	"@maple/http/errors/UnauthorizedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 401 },
) {}

export class TenantSchema extends Schema.Class<TenantSchema>("TenantSchema")({
	orgId: OrgId,
	userId: UserId,
	roles: Schema.Array(RoleName),
	authMode: AuthMode,
}) {}

export class Context extends EffectContext.Service<Context, TenantSchema>()(
	"@maple/domain/http/CurrentTenant",
) {}

export class Authorization extends HttpApiMiddleware.Service<
	Authorization,
	{
		provides: Context
	}
>()("Authorization", {
	error: UnauthorizedError,
	security: {
		bearer: HttpApiSecurity.bearer,
	},
}) {}

/**
 * Server-to-server auth for internal endpoints (the chat-flue `submit_diagnosis`
 * write, etc.). Verifies the internal-service bearer token rather than a Clerk
 * session, but provides the same {@link Context} so handlers read the tenant
 * uniformly. The implementation lives in `apps/api` (InternalServiceAuthorizationLayer).
 */
export class InternalServiceAuthorization extends HttpApiMiddleware.Service<
	InternalServiceAuthorization,
	{
		provides: Context
	}
>()("InternalServiceAuthorization", {
	error: UnauthorizedError,
	security: {
		bearer: HttpApiSecurity.bearer,
	},
}) {}
