import { MapleRegion } from "@maple/domain/organization-regions"
import { Schema } from "effect"
import { PendingSessionTask } from "../../platform/clerk"

// The Clerk screens without state of their own: `/sign-up` (Clerk's card) and the wrong-region notice.
// Their views are in `view.ts`.

/** `SignUpPage`: Clerk's sign-up card, landing in onboarding unless a redirect is carried. */
export const SignUp = Schema.TaggedStruct("SignUp", { target: Schema.String })
export type SignUp = typeof SignUp.Type

/** `WrongRegionScreen`: the org lives in another region; `href` is the page to open there. */
export const WrongRegion = Schema.TaggedStruct("WrongRegion", { region: MapleRegion, href: Schema.String })
export type WrongRegion = typeof WrongRegion.Type

/** `/sign-in` with a pending session: Clerk's card for its task, then `target`. */
export const SessionTask = Schema.TaggedStruct("SessionTask", {
	task: PendingSessionTask,
	target: Schema.String,
})
export type SessionTask = typeof SessionTask.Type
