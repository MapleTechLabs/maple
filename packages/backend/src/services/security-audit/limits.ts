/**
 * Every operating limit of the security audit, in one place. Each reads its env variable and falls
 * back to the default here; a blank, negative or malformed value reads as unset.
 */
import { Config, Effect, Option } from "effect"

export interface SecurityAuditLimits {
	/** Monthly invocations for an org billing does not meter (self-hosted, local, Maple's own org). */
	readonly unmeteredMonthlyInvocations: number
	/** Bytes of tracked files at the pinned commit. */
	readonly maxCheckoutBytes: number
	/** Tracked files at the pinned commit. */
	readonly maxFiles: number
	/** Commits reachable from the pinned commit. */
	readonly maxHistoryCommits: number
	/** Git LFS files: their content is not in the checkout, so the audit could not read them. */
	readonly maxLfsFiles: number
}

export const SECURITY_AUDIT_LIMIT_DEFAULTS: SecurityAuditLimits = {
	unmeteredMonthlyInvocations: 20_000,
	maxCheckoutBytes: 1024 * 1024 * 1024,
	maxFiles: 100_000,
	maxHistoryCommits: 1_000_000,
	maxLfsFiles: 0,
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
	maxCheckoutBytes: limit(
		"SECURITY_AUDIT_MAX_CHECKOUT_BYTES",
		SECURITY_AUDIT_LIMIT_DEFAULTS.maxCheckoutBytes,
	),
	maxFiles: limit("SECURITY_AUDIT_MAX_FILES", SECURITY_AUDIT_LIMIT_DEFAULTS.maxFiles),
	maxHistoryCommits: limit(
		"SECURITY_AUDIT_MAX_HISTORY_COMMITS",
		SECURITY_AUDIT_LIMIT_DEFAULTS.maxHistoryCommits,
	),
	maxLfsFiles: limit("SECURITY_AUDIT_MAX_LFS_FILES", SECURITY_AUDIT_LIMIT_DEFAULTS.maxLfsFiles),
})

/** The limits from the current config provider (the Worker's env), defaults where unset. */
export const securityAuditLimits: Effect.Effect<SecurityAuditLimits> = limitsConfig.pipe(
	Effect.orElseSucceed(() => SECURITY_AUDIT_LIMIT_DEFAULTS),
)
