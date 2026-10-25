/**
 * Every operating limit of the security audit, in one place. Each reads its env variable and falls
 * back to the default here; a blank, negative or malformed value reads as unset.
 */
import { Config, Effect, Option } from "effect"

export interface SecurityAuditLimits {
	/** Bytes GitHub reports for the repository (its packed history), checked before any clone. */
	readonly maxRepositoryBytes: number
	/** Bytes of tracked files at the pinned commit. */
	readonly maxCheckoutBytes: number
	/** Tracked files at the pinned commit. */
	readonly maxFiles: number
	/** Commits reachable from the pinned commit. */
	readonly maxHistoryCommits: number
	/** Git LFS files: their content is not in the checkout, so the audit could not read them. */
	readonly maxLfsFiles: number
	/** An org's monthly spend limit in whole US dollars until an admin sets its own. */
	readonly defaultMonthlySpendLimitUsd: number
	/**
	 * US dollars of AI credits each agent invocation pays for its sandbox, on top of its model cost.
	 * An agent keeps a standard-2 container busy for minutes (about $0.13 an hour), shared with the
	 * run's other agents, plus the idle tail before it sleeps.
	 */
	readonly sandboxFeeUsd: number
}

export const SECURITY_AUDIT_LIMIT_DEFAULTS: SecurityAuditLimits = {
	maxRepositoryBytes: 2 * 1024 * 1024 * 1024,
	maxCheckoutBytes: 1024 * 1024 * 1024,
	maxFiles: 100_000,
	maxHistoryCommits: 1_000_000,
	maxLfsFiles: 0,
	defaultMonthlySpendLimitUsd: 100,
	sandboxFeeUsd: 0.02,
}

/** Postgres `int4`, the spend limit column. */
export const MAX_LIMIT = 2_147_483_647

/** A sandbox fee above a dollar per agent is a typo, not a price. */
const MAX_SANDBOX_FEE_USD = 1

const limit = (name: string, fallback: number, max = Number.MAX_SAFE_INTEGER) =>
	Config.option(Config.Int(name)).pipe(
		Config.orElse(() => Config.succeed(Option.none<number>())),
		Config.map((value) =>
			Math.min(
				max,
				Option.getOrElse(
					Option.filter(value, (n) => n >= 0),
					() => fallback,
				),
			),
		),
	)

const sandboxFee = Config.option(Config.Number("SECURITY_AUDIT_SANDBOX_FEE_USD")).pipe(
	Config.orElse(() => Config.succeed(Option.none<number>())),
	Config.map((value) =>
		Option.getOrElse(
			Option.filter(value, (n) => Number.isFinite(n) && n >= 0 && n <= MAX_SANDBOX_FEE_USD),
			() => SECURITY_AUDIT_LIMIT_DEFAULTS.sandboxFeeUsd,
		),
	),
)

const limitsConfig = Config.all({
	maxRepositoryBytes: limit(
		"SECURITY_AUDIT_MAX_REPOSITORY_BYTES",
		SECURITY_AUDIT_LIMIT_DEFAULTS.maxRepositoryBytes,
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
	defaultMonthlySpendLimitUsd: limit(
		"SECURITY_AUDIT_DEFAULT_MONTHLY_SPEND_USD",
		SECURITY_AUDIT_LIMIT_DEFAULTS.defaultMonthlySpendLimitUsd,
		MAX_LIMIT,
	),
	sandboxFeeUsd: sandboxFee,
})

/** The limits from the current config provider (the Worker's env), defaults where unset. */
export const securityAuditLimits: Effect.Effect<SecurityAuditLimits> = limitsConfig.pipe(
	Effect.orElseSucceed(() => SECURITY_AUDIT_LIMIT_DEFAULTS),
)
