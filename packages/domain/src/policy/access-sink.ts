import { Context, Effect } from "effect"
import type { Permission } from "./permissions"

/** One permission `check` asked for, and whether the grants held it. */
export interface AccessCheck {
	readonly permission: Permission
	readonly allowed: boolean
}

/**
 * Where `check` reports what it asked. The auth layers set it for a request, so a refusal made
 * inside a handler or service is recorded like one made at the gate; anywhere else it does nothing.
 */
export class AccessSink extends Context.Reference<(asked: AccessCheck) => Effect.Effect<void>>(
	"@maple/policy/AccessSink",
	{ defaultValue: () => () => Effect.void },
) {}
