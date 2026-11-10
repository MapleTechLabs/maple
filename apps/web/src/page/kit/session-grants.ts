import * as Policy from "@maple/domain/policy"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { CallableTaggedStruct } from "foldkit/schema"
import { readGrants } from "../../data/session-tenant"

// A page's read of the viewer's permissions: the answer carries the org it was asked for, so a
// late answer for another org is dropped.

/** The answer's fields: the org asked for and the session's grants. */
export const SessionGrants = { orgId: Schema.String, grants: Schema.Array(Policy.PermissionName) }
export type SessionGrants = Readonly<{ orgId: string; grants: ReadonlyArray<Policy.Permission> }>

type Grants = Readonly<{ grants: ReadonlyArray<Policy.Permission> }>

/** A page's own grants read, tagged with the org it was asked for. */
export const fetchSessionGrants = <const Name extends string, const Tag extends string>(
	name: Name,
	completed: CallableTaggedStruct<Tag, typeof SessionGrants>,
) =>
	Command.define(name, {
		args: { orgId: Schema.String },
		messages: [completed],
		execute: ({ orgId }) => Effect.map(readGrants, (grants) => completed({ orgId, grants })),
	})

/** The Model with the answered grants (and `also`) when the answer is for the page's org. */
export const acceptGrants = <M extends Grants>(
	model: M,
	pageOrgId: string,
	answer: SessionGrants,
	also?: Partial<M>,
): M => (answer.orgId === pageOrgId ? { ...model, grants: answer.grants, ...also } : model)

/** The viewer may change alert rules, schedules, SLOs and routing (`alerts:manage`). */
export const canManageAlerts = (model: Grants): boolean => Policy.has(model.grants, "alerts:manage")
