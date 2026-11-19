import { Schema } from "effect"

/**
 * What a deleted organization left outside Postgres, one kind per store: a `chat_session` is one
 * agent conversation's Durable Object, `replay_blobs` the org's session-replay objects.
 */
export const OrgErasureKind = Schema.Literals(["chat_session", "replay_blobs"])
export type OrgErasureKind = typeof OrgErasureKind.Type
