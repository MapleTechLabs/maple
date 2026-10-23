/**
 * Every operating limit of the security audit, in one place. Each reads its env variable and falls
 * back to the default here; a blank, negative or malformed value reads as unset.
 */
import { Config, Effect, Option } from "effect"

export interface SecurityAuditLimits {
	/** Monthly invocations for an org billing does not meter (self-hosted, local, Maple's own org). */
	readonly unmeteredMonthlyInvocations: number
}

export const SECURITY_AUDIT_LIMIT_DEFAULTS: SecurityAuditLimits = {
	unmeteredMonthlyInvocations: 20_000,
}

const limit = (name: string, fallback: number) =>
	Config.option(Config.Int(name)).pipe(
		Config.orElse(() => Config.succeed(Option.none<number>())),
		Config.map((value) =>
			Option.getOrElse(
				Option.filter(value, (n) => n >= 0),
				() => fallback,
			),
		),
	)

const limitsConfig = Config.all({
	unmeteredMonthlyInvocations: limit(
		"SECURITY_AUDIT_UNMETERED_MONTHLY_INVOCATIONS",
		SECURITY_AUDIT_LIMIT_DEFAULTS.unmeteredMonthlyInvocations,
	),
})

/** The limits from the current config provider (the Worker's env), defaults where unset. */
export const securityAuditLimits: Effect.Effect<SecurityAuditLimits> = limitsConfig.pipe(
	Effect.orElseSucceed(() => SECURITY_AUDIT_LIMIT_DEFAULTS),
)
