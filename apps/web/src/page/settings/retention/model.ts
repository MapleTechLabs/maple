import * as Policy from "@maple/domain/policy"
import { V2RetentionDays, V2RetentionPolicy } from "@maple/domain/http/v2"
import { RetentionSignal } from "@maple/domain/retention"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"

// The Retention tab: how long the organization keeps each signal, and the sources that differ.

export const PolicyData = AsyncData.Schema(V2RetentionPolicy, LoadFailure)

/** A source that keeps a period of its own, as the tab names and links it. */
export const SourceName = Schema.Struct({ id: Schema.String, name: Schema.String })
export type SourceName = typeof SourceName.Type

export const Model = Schema.Struct({
	grants: Schema.Array(Policy.PermissionName),
	policy: PolicyData.schema,
	/** The period picked per signal, `null` until the stored policy loads. */
	draft: Schema.NullOr(V2RetentionDays),
	isSaving: Schema.Boolean,
	/** The org's sources by id, `null` until they load: only names, for the overrides list. */
	sourceNames: Schema.NullOr(Schema.Array(SourceName)),
	/** Read when a period changes, so a "by" date never counts from an unread clock. */
	nowMs: Schema.NullOr(Schema.Number),
})
export type Model = typeof Model.Type

/** The viewer may change retention. */
export const canManage = (model: Pick<Model, "grants">): boolean =>
	Policy.can(model.grants, "retention:manage")

const done = <A extends Schema.Top>(schema: A) => ({ result: Schema.Result(schema, LoadFailure) })

export const Message = defineMessageUnion({
	CompletedFetchPolicy: done(V2RetentionPolicy),
	CompletedFetchSources: done(Schema.Array(SourceName)),
	ClickedRetry: {},
	ChangedPeriod: { signal: RetentionSignal, value: Schema.String },
	ReadClock: { nowMs: Schema.Number },
	ClickedDiscard: {},
	ClickedSave: {},
	CompletedSave: done(V2RetentionPolicy),
})
export type Message = typeof Message.Type
