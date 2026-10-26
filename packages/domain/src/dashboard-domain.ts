import * as Domain from "@alchemy.run/domain"
import { Schema } from "effect"
import { DashboardId, OrgId } from "./primitives"

/** Internal aggregate identity: always derive from the authenticated tenant, never client input. */
export const dashboardDomainKey = (orgId: OrgId, dashboardId: DashboardId): string =>
	JSON.stringify([orgId, dashboardId])

const Name = Schema.String.check(Schema.isMinLength(1))
export const DashboardNameState = Schema.NullOr(Name)

export class DashboardNameImported extends Domain.Event("DashboardNameImported", { name: Name }) {}
export class DashboardRenamed extends Domain.Event("DashboardRenamed", { name: Name }) {}

export class DashboardNameMissing extends Domain.Rejection("@maple/dashboard/NameMissing", {
	message: Schema.String,
}) {}
export class DashboardNameAlreadyImported extends Domain.Rejection("@maple/dashboard/NameAlreadyImported", {
	message: Schema.String,
}) {}

export class ImportDashboardName extends Domain.Command("ImportDashboardName", {
	target: Schema.String,
	input: { name: Name },
	events: [DashboardNameImported],
	rejects: [DashboardNameAlreadyImported],
}) {}
export class RenameDashboard extends Domain.Command("RenameDashboard", {
	target: Schema.String,
	input: { name: Name },
	events: [DashboardRenamed],
	rejects: [DashboardNameMissing],
}) {}

/** Shared with the Postgres adapter; decisions are re-run against the latest CAS state. */
export const decideDashboardRename = (
	name: string,
	command: RenameDashboard,
): ReadonlyArray<DashboardRenamed> =>
	name === command.name ? [] : [new DashboardRenamed({ name: command.name })]

export const evolveDashboardRename = (_name: string | null, event: DashboardRenamed): string => event.name

/**
 * The first dashboard domain context. This model is not mounted on a public Api or a DO yet.
 * Production uses its rename decision/fold through Postgres; hosting it would require a
 * coordinated cutover of every writer, authenticated reads, and a deletion tombstone.
 */
export class DashboardNames extends Domain.Aggregate("MapleDashboardNames", {
	id: Schema.String,
	state: DashboardNameState,
	initial: null,
	commands: [ImportDashboardName, RenameDashboard],
	decide: {
		ImportDashboardName: (state, command) =>
			state === null
				? [new DashboardNameImported({ name: command.name })]
				: new DashboardNameAlreadyImported({ message: "Dashboard name has already been imported" }),
		RenameDashboard: (state, command) =>
			state === null
				? new DashboardNameMissing({ message: "Dashboard name has not been imported" })
				: decideDashboardRename(state, command),
	},
	evolve: {
		DashboardNameImported: (_state, event) => event.name,
		DashboardRenamed: evolveDashboardRename,
	},
}) {}

export class DashboardNameView extends Domain.View("MapleDashboardNameView", {
	from: [DashboardNames],
	key: DashboardNames,
	state: DashboardNameState,
	initial: null,
	evolve: {
		DashboardNameImported: (_state, event) => event.name,
		DashboardRenamed: evolveDashboardRename,
	},
}) {}

export class DashboardNameModel extends Domain.Model("MapleDashboardNames", {
	aggregates: [DashboardNames],
	views: [DashboardNameView],
}) {}
