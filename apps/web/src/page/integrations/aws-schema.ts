import { Schema } from "effect"

// `AwsIntegrationCard`'s schemas that its Messages carry, apart from `./aws`, which imports them.

export const AwsSetupMethod = Schema.Literals(["cloudshell", "console", "terraform"])
export type AwsSetupMethod = typeof AwsSetupMethod.Type

/** A stack a disconnect left in AWS, and the script that deletes it. Kept until dismissed. */
export const AwsRemovedStack = Schema.Struct({
	connectionId: Schema.String,
	accountId: Schema.String,
	cleanupScript: Schema.String,
})
export type AwsRemovedStack = typeof AwsRemovedStack.Type
