import * as PG from "@maple-dev/effect-orm/postgres"

/** Failed root-password logins per throttle key (a hashed client address, or the global root key). */
export const SelfHostedLoginAttempts = PG.table("self_hosted_login_attempts", {
	columns: {
		key: PG.column(PG.text, { name: "key" }),
		failures: PG.column(PG.int4, { name: "failures" }),
		windowStartedAt: PG.column(PG.timestamptzMillis, { name: "window_started_at" }),
		lockedUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "locked_until" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["key"],
	indexes: [PG.index("self_hosted_login_attempts_updated_idx", ["updatedAt"])],
})

export type SelfHostedLoginAttemptRow = PG.SelectRowOf<typeof SelfHostedLoginAttempts>
