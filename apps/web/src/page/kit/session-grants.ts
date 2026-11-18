import * as Policy from "@maple/domain/policy"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { lockedControl } from "@maple/views/ui/locked-control"
import type { CallableTaggedStruct } from "foldkit/schema"
import { readGrants } from "../../data/session-tenant"

// A page's read of the viewer's permissions: the answer carries the org it was asked for, so a
// late answer for another org is dropped.

/** The answer's fields: the org asked for and the session's grants. */
export const SessionGrants = { orgId: Schema.String, grants: Schema.Array(Policy.PermissionName) }
export type SessionGrants = Readonly<{ orgId: string; grants: ReadonlyArray<Policy.Permission> }>

export type Grants = Readonly<{ grants: ReadonlyArray<Policy.Permission> }>

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

/** The viewer may acknowledge and resolve alert and anomaly incidents (`incidents:respond`). */
export const canRespondToIncidents = (model: Grants): boolean => Policy.has(model.grants, "incidents:respond")

/** The viewer may start, restart and resolve investigations (`investigations:run`). */
export const canRunInvestigations = (model: Grants): boolean => Policy.has(model.grants, "investigations:run")

/** The viewer may open the audit log (`audit_log:read`); false until the session answers. */
export const canReadAuditLog = (model: Grants): boolean => Policy.has(model.grants, "audit_log:read")

/**
 * A control behind `permission`: enabled when the viewer holds it, else drawn disabled with the
 * denial as its tooltip, so people see what exists and who can use it instead of a gap.
 */
export const gatedControl = <Message>(
	h: HtmlBuilder<Message>,
	model: Grants,
	permission: Policy.Permission,
	control: (isDisabled: boolean) => Html,
	options: Readonly<{ className?: string }> = {},
): Html =>
	Policy.has(model.grants, permission)
		? control(false)
		: lockedControl(h, Policy.denialFor(permission).message, control(true), options)

/** The denial a disabled menu item or field shows for `permission`. */
export const denialReason = (permission: Policy.Permission): string => Policy.denialFor(permission).message
