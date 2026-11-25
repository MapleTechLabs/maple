import { DEFAULT_RETENTION_DAYS } from "../retention"

/**
 * True until the deploy that partitions the raw tables by `RetentionDays` is live in every
 * workspace. Set it to `false` in the PR right after: every one-shot config below then reverts.
 * Left on, the next deploy that copies a table resets its rows' stamps (docs/warehouse-rollups.md).
 */
export const RETENTION_ROLLOUT_PENDING: boolean = true

/**
 * A datasource fed from a raw table copies its rows from the live deployment while the raw tables
 * are copied, instead of replaying them, which would drop each rollup's longer history.
 */
export const RETENTION_REPARTITION_FORWARD: { readonly forwardQuery?: string } = RETENTION_ROLLOUT_PENDING
	? { forwardQuery: "SELECT *" }
	: {}

/** A span projection gaining `RetentionDays` (last in its schema): its existing rows kept 30 days. */
export const RETENTION_COLUMN_FORWARD: { readonly forwardQuery?: string } = RETENTION_ROLLOUT_PENDING
	? { forwardQuery: `SELECT *, toUInt16(${DEFAULT_RETENTION_DAYS.traces}) AS RetentionDays` }
	: {}

/**
 * `product_events` always copies forward (a rebuild drops `/v1/events` rows); during the rollout its
 * existing rows also gain `RetentionDays` at the events default.
 */
export const PRODUCT_EVENTS_FORWARD_QUERY: string = RETENTION_ROLLOUT_PENDING
	? `SELECT *, toUInt16(${DEFAULT_RETENTION_DAYS.events}) AS RetentionDays`
	: "SELECT *"

/**
 * `deploymentMethod: "alter"` for the trace views that had it: Tinybird refuses a pending `alter`
 * while the deploy copies `traces`, so it comes back once the rollout is done.
 */
export const ALTER_AFTER_RETENTION_ROLLOUT: { readonly deploymentMethod?: "alter" } =
	RETENTION_ROLLOUT_PENDING ? {} : { deploymentMethod: "alter" }
