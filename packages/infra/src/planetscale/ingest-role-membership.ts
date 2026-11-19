// Grants the ingest gateway's login its group role on a hosted Postgres branch, at deploy time.
// The hosted roles API only lets a login inherit built-in roles, so membership in `maple_ingest`
// (created by a migration) is a GRANT run as a short-lived admin login, the way migrations run.
import { type SqlExecutor, withPgExecutor } from "@alchemy.run/sql/Migrations"
import { stripSslQueryParams } from "@alchemy.run/sql/PostgresDriver"
import * as planetscale from "@distilled.cloud/planetscale"
import { Credentials } from "@distilled.cloud/planetscale/Credentials"
import { INGEST_GATEWAY_ROLE, ingestRoleMembershipSql } from "@maple/db/roles"
import { isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"

/** The membership grant failed: the deploy stops before the gateway switches logins. */
export class IngestRoleGrantError extends Schema.TaggedError<IngestRoleGrantError>()(
	"@maple/infra/IngestRoleGrantError",
	{ message: Schema.String, login: Schema.String, cause: Schema.Defect() },
) {}

/** Seconds the admin login lives if its delete is lost. */
const ADMIN_LOGIN_TTL_SECONDS = 600

export interface IngestRoleMembershipProps {
	/** The hosted database's name. */
	database: string
	/** The branch the login and the migrated group role live on. */
	branch: string
	/** The login's id; echoed so the gateway's env orders it after this grant. */
	loginId: string
	/** The login's Postgres role name. */
	login: string
	/** The login's connection URL; echoed so the gateway's secret is written only after the grant. */
	url: Redacted.Redacted
}

export interface IngestRoleMembershipAttributes {
	loginId: string
	login: string
	groupRole: string
	url: Redacted.Redacted
}

export type IngestRoleMembership = Resource<
	"Maple.IngestRoleMembership",
	IngestRoleMembershipProps,
	IngestRoleMembershipAttributes,
	never,
	MapleDbProviders
>

export const IngestRoleMembership = Resource<IngestRoleMembership>("Maple.IngestRoleMembership")

/** A verified-TLS session as an admin login that is deleted when `use` ends. */
const withAdminSession = <A, E, R>(
	target: { organization: string; database: string; branch: string },
	use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
) =>
	Effect.acquireUseRelease(
		planetscale.createRole({
			organization: target.organization,
			database: target.database,
			branch: target.branch,
			ttl: ADMIN_LOGIN_TTL_SECONDS,
			inherited_roles: ["postgres"],
		}),
		(created) => {
			const password = encodeURIComponent(Redacted.value(created.password ?? Redacted.make("")))
			const url = `postgresql://${encodeURIComponent(created.username)}:${password}@${created.access_host_url}:5432/${created.database_name}`
			return withPgExecutor(
				{ connectionString: stripSslQueryParams(url), ssl: { rejectUnauthorized: true } },
				use,
			)
		},
		(created) =>
			planetscale
				.deleteRole({
					organization: target.organization,
					database: target.database,
					branch: target.branch,
					id: created.id,
					successor: "postgres",
				})
				.pipe(
					Effect.catchTag("NotFound", () => Effect.void),
					Effect.retry({
						schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(5)]),
					}),
					// The grant is done; the login's TTL bounds a lost delete.
					Effect.catch(() =>
						Effect.logWarning(
							`admin login ${created.id} was not deleted; it expires in ${ADMIN_LOGIN_TTL_SECONDS}s`,
						),
					),
				),
	)

const grant = (props: IngestRoleMembershipProps) =>
	Effect.gen(function* () {
		const { organization } = yield* yield* Credentials
		yield* withAdminSession(
			{ organization, database: props.database, branch: props.branch },
			(executor) => executor.query(ingestRoleMembershipSql(props.login)),
		)
		return {
			loginId: props.loginId,
			login: props.login,
			groupRole: INGEST_GATEWAY_ROLE,
			url: props.url,
		}
	}).pipe(
		Effect.mapError(
			(cause) =>
				new IngestRoleGrantError({
					message: `could not grant ${INGEST_GATEWAY_ROLE} to the ingest login`,
					login: props.login,
					cause,
				}),
		),
	)

export const IngestRoleMembershipProvider = Provider.succeed(IngestRoleMembership, {
	diff: Effect.fn(function* ({ news, olds }) {
		if (!isResolved(news)) return undefined
		const same =
			news.login === olds.login &&
			news.loginId === olds.loginId &&
			news.branch === olds.branch &&
			news.database === olds.database &&
			// State from before the URL was echoed has none; that is an update, not a crash.
			Redacted.isRedacted(olds.url) &&
			Redacted.value(news.url) === Redacted.value(olds.url)
		return same ? undefined : ({ action: "update" } as const)
	}),
	read: Effect.fn(function* ({ output }) {
		return output
	}),
	reconcile: Effect.fn(function* ({ news }) {
		return yield* grant(news)
	}),
	// The login goes with its own role resource; nothing to revoke from a deleted login.
	delete: () => Effect.void,
})

export class MapleDbProviders extends Provider.ProviderCollection<MapleDbProviders>()("MapleDb") {}

/** Needs the hosted database's credentials and HTTP client, which its own providers layer exports. */
export const mapleDbProviders = Layer.effect(
	MapleDbProviders,
	Provider.collection([IngestRoleMembership]),
).pipe(Layer.provide(IngestRoleMembershipProvider))
