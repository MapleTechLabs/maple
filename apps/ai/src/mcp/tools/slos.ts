/**
 * SLOs: a target share of good entry-point spans for one service over a rolling window, with a
 * hidden burn-rate alert rule. Anyone may read them; writes need `alerts:manage`, like the REST routes.
 */
import { Effect, Order, Schema, Array as Arr } from "effect"
import {
	DeleteSloOutput,
	InspectSloOutput,
	ListSlosOutput,
	SloMutationOutput,
	type SloConfigRow,
	type SloListRow,
} from "@maple/domain/mcp-outputs"
import type { AlertDestinationId } from "@maple/domain/primitives"
import * as Policy from "@maple/domain/policy"
import { SlosService } from "@maple/backend/services/slos/SlosService"
import { McpInvalidInputError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc, type NextCall } from "../lib/tool-doc"
import {
	buildSli,
	burn,
	burningTier,
	decodeWindowDays,
	percent,
	resolveSlo,
	SLI_KINDS,
	sliSummary,
	toMcpSloError,
	toSloConfigRow,
	toSloStatusRow,
	windowLabel,
	worstWindow,
} from "../lib/slos"

const canManage = (tool: string) =>
	Effect.gen(function* () {
		const tenant = yield* CurrentMcpTenant
		yield* Policy.check(
			tenant.roles,
			"alerts:manage",
			() =>
				new McpUnavailableError({
					message: `${tool} changes the organization's SLOs and their burn-rate alerts, which only org admins and engineers may do. Ask an admin or engineer, or change it in Maple.`,
					capability: "org_admin",
				}),
		)
		return tenant
	})

const decodeDestinations = (raw: ReadonlyArray<string> | undefined, parameter: string) =>
	raw === undefined
		? Effect.undefined
		: Effect.forEach(raw, P.decodeResourceId("alertDestination", parameter))

/** The alerting fields a caller sent; undefined when none. */
const alertingInput = Effect.fnUntraced(function* (params: {
	readonly alerting_enabled?: boolean | undefined
	readonly critical_destination_ids?: ReadonlyArray<string> | undefined
	readonly warning_destination_ids?: ReadonlyArray<string> | undefined
}) {
	const critical: ReadonlyArray<AlertDestinationId> | undefined = yield* decodeDestinations(
		params.critical_destination_ids,
		"critical_destination_ids",
	)
	const warning: ReadonlyArray<AlertDestinationId> | undefined = yield* decodeDestinations(
		params.warning_destination_ids,
		"warning_destination_ids",
	)
	if (params.alerting_enabled === undefined && critical === undefined && warning === undefined) {
		return undefined
	}
	return {
		...(params.alerting_enabled === undefined ? undefined : { enabled: params.alerting_enabled }),
		...(critical === undefined ? undefined : { criticalDestinationIds: critical }),
		...(warning === undefined ? undefined : { warningDestinationIds: warning }),
	}
})

const BURN_TIER_TEXT =
	"Its burn-rate alert pages (critical) when the 1h and 5m windows both burn at 14.4x or more, and opens a ticket (warning) at 6x over 6h and 30m."

const destinationsCell = (ids: ReadonlyArray<string>) => (ids.length === 0 ? "none" : Arr.join(ids, ", "))

const configFields = (row: typeof SloConfigRow.Type) =>
	doc.fields([
		["Name", row.name],
		["Id", row.id],
		["Service", row.serviceName],
		["Environments", row.environments.length === 0 ? "all" : Arr.join(row.environments, ", ")],
		["SLI", sliSummary(row)],
		["Target", `${row.targetPercent}% over ${row.windowDays} days`],
		["Description", row.description ?? undefined],
		["Burn alerts", row.alerting.enabled ? "on" : "off"],
		["Critical notifies", destinationsCell(row.alerting.criticalDestinationIds)],
		["Warning notifies", destinationsCell(row.alerting.warningDestinationIds)],
		["Alert rule", row.alerting.alertRuleId ?? "none"],
	])

const ruleNext = (row: typeof SloConfigRow.Type): ReadonlyArray<NextCall> =>
	row.alerting.alertRuleId === null
		? []
		: [
				doc.next(
					"get_incident_timeline",
					{ rule_id: row.alerting.alertRuleId },
					`the burn-rate incidents of "${row.name}"`,
				),
			]

const renderMutation = (title: string, row: typeof SloConfigRow.Type) => ({
	title,
	notices: row.alerting.enabled
		? []
		: ["Burn-rate alerts are off: nothing pages. update_slo alerting_enabled=true turns them on."],
	blocks: [configFields(row), doc.text(BURN_TIER_TEXT)],
	next: [doc.next("inspect_slo", { slo: row.name }, `where "${row.name}" stands now`)],
})

const BURNING_ORDER = { critical: 0, warning: 1 } as const
const rank = (row: typeof SloListRow.Type) => (row.burning === null ? 2 : BURNING_ORDER[row.burning])
/** Breaching tiers first (critical, then warning), then the least budget left. */
const LIST_ORDER = Order.combine(
	Order.mapInput(Order.Number, rank),
	Order.mapInput(
		Order.Number,
		(row: typeof SloListRow.Type) => row.budgetRemaining ?? Number.POSITIVE_INFINITY,
	),
)

const sloParameters = {
	description: P.optionalText("What the SLO promises, for people reading it"),
	environments: P.optionalList(
		"Deployment environments whose spans count (e.g. production). Omit or [] for every environment",
	),
	threshold_ms: P.optionalNumber(
		"latency SLI only: a span is good when faster than this, one of 50, 100, 250, 500, 1000, 2500, 5000, 10000",
	),
	window_days: P.optionalNumber("Rolling window the error budget covers: 7, 28 or 30 days (default 30)"),
	alerting_enabled: P.optionalFlag("Whether the SLO's burn-rate alert fires (default true)"),
	critical_destination_ids: P.optionalResourceIdList(
		"alertDestination",
		"Alert destinations paged by a fast burn (14.4x over 1h and 5m); list_alert_destinations lists them",
	),
	warning_destination_ids: P.optionalResourceIdList(
		"alertDestination",
		"Alert destinations ticketed by a slow burn (6x over 6h and 30m); a critical incident notifies them too",
	),
} as const

export function registerSloTools(server: McpToolRegistrar) {
	server.define({
		name: "list_slos",
		title: "List SLOs",
		description:
			"Every SLO with its current SLI, error budget left and the worst burn rate over the 5m, 30m, 1h and 6h windows. SLOs whose burn-rate alert tier is breaching come first (critical, then warning), then the least budget left. inspect_slo shows one SLO's windows and alerting.",
		parameters: Schema.Struct({
			service: P.service("Only SLOs on this service (exact `service.name`)"),
		}),
		aliases: P.SERVICE_ALIASES,
		output: ListSlosOutput,
		hints: { readOnly: true, destructive: false, idempotent: true },
		phrases: ["Checking SLOs"],
		handler: Effect.fn("McpTool.listSlos")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const service = yield* SlosService
			const slos = yield* service.list(tenant.orgId).pipe(Effect.mapError(toMcpSloError("list_slos")))
			const shown = Arr.filter(
				slos,
				(slo) => params.service === undefined || slo.serviceName === params.service,
			)
			// One SLO's failed read leaves its status empty instead of failing the whole list.
			const rows = yield* Effect.forEach(
				shown,
				(slo) =>
					service.status(tenant, slo.id).pipe(
						Effect.match({
							onFailure: (error): typeof SloListRow.Type => ({
								...toSloConfigRow(slo),
								sli: null,
								budgetRemaining: null,
								worstBurnRate: null,
								worstBurnWindow: null,
								burning: null,
								statusError: error.message,
							}),
							onSuccess: (status): typeof SloListRow.Type => {
								const worst = worstWindow(status.burnWindows)
								return {
									...toSloConfigRow(slo),
									sli: status.sli,
									budgetRemaining: status.budgetRemaining,
									worstBurnRate: worst?.burnRate ?? null,
									worstBurnWindow:
										worst === undefined ? null : windowLabel(worst.windowMinutes),
									burning: burningTier(status.burnWindows),
									statusError: null,
								}
							},
						}),
					),
				{ concurrency: 4 },
			)
			const sorted = Arr.sort(rows, LIST_ORDER)
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "result.rowCount": sorted.length })
			return {
				slos: sorted,
				total: sorted.length,
				...(params.service === undefined ? undefined : { serviceFilter: params.service }),
			}
		}),
		render: (output) => ({
			title: "SLOs",
			scope: [["Service", output.serviceFilter]],
			notices: Arr.map(
				Arr.filter(output.slos, (row) => row.statusError !== null),
				(row) => `Could not read the status of "${row.name}": ${row.statusError ?? ""}`,
			),
			...(output.slos.length === 0
				? {
						empty: {
							message:
								output.serviceFilter === undefined
									? "This organization has no SLOs."
									: "No SLO is set on this service.",
							hints: ["create_slo adds one (org admins and engineers only)."],
						},
					}
				: undefined),
			blocks:
				output.slos.length === 0
					? []
					: [
							doc.table(
								[
									"Name",
									"Service",
									"SLI",
									"Target",
									"Current",
									"Budget left",
									"Worst burn",
									"Burning",
								],
								Arr.map(output.slos, (row) => [
									row.name,
									row.serviceName,
									sliSummary(row),
									`${row.targetPercent}% / ${row.windowDays}d`,
									percent(row.sli),
									percent(row.budgetRemaining, 1),
									row.worstBurnWindow === null
										? "-"
										: `${burn(row.worstBurnRate)} (${row.worstBurnWindow})`,
									row.burning ?? "-",
								]),
							),
						],
			next: Arr.map(Arr.filter(output.slos, (row) => row.burning !== null).slice(0, 3), (row) =>
				doc.next("inspect_slo", { slo: row.name }, `the burn windows of "${row.name}"`),
			),
		}),
	})

	server.define({
		name: "inspect_slo",
		title: "Inspect SLO",
		description:
			"One SLO in full: its config (service, environments, SLI, target, window), where it stands now (total and good events, SLI, error budget left, the burn rate of each 5m, 30m, 1h and 6h window and which alert tier breaches) and its burn-rate alerting (on or off, destinations per tier, alert rule id).",
		parameters: Schema.Struct({
			slo: P.text("The SLO's name or id (list_slos lists them)"),
		}),
		output: InspectSloOutput,
		hints: { readOnly: true, destructive: false, idempotent: true },
		phrases: ["Inspecting an SLO"],
		handler: Effect.fn("McpTool.inspectSlo")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const service = yield* SlosService
			const slo = yield* resolveSlo("inspect_slo", tenant.orgId, params.slo)
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.slo.id": slo.id })
			const status = yield* service.status(tenant, slo.id).pipe(
				Effect.catchTags({
					"@maple/http/errors/SloNotFoundError": (error) =>
						Effect.fail(toMcpSloError("inspect_slo")(error)),
					"@maple/http/errors/SloPersistenceError": (error) =>
						Effect.fail(toMcpSloError("inspect_slo")(error)),
				}),
				Effect.catchTags(warehouseReadToMcpHandlers("inspect_slo")),
			)
			return { slo: toSloConfigRow(slo), status: toSloStatusRow(status) }
		}),
		render: (output) => {
			const breached = Arr.filter(output.status.tiers, (tier) => tier.breached)
			return {
				title: `SLO: ${output.slo.name}`,
				notices: [
					...Arr.map(
						breached,
						(tier) =>
							`The ${tier.severity} tier is breaching: ${tier.longWindow} and ${tier.shortWindow} both burn at ${tier.factor}x or more.`,
					),
					...(output.status.budgetRemaining < 0 ? ["The error budget is spent."] : []),
					...(output.status.total === 0
						? [`No entry-point spans from ${output.slo.serviceName} in the window yet.`]
						: []),
				],
				blocks: [
					configFields(output.slo),
					doc.fields([
						["As of", output.status.asOf],
						["Events", `${output.status.good} good of ${output.status.total}`],
						["SLI", percent(output.status.sli)],
						["Budget left", percent(output.status.budgetRemaining, 1)],
					]),
					doc.table(
						["Window", "Events", "Good", "Burn rate"],
						Arr.map(output.status.burnWindows, (window) => [
							window.window,
							String(window.total),
							String(window.good),
							burn(window.burnRate),
						]),
					),
					doc.table(
						["Tier", "Fires at", "Windows", "Breaching"],
						Arr.map(output.status.tiers, (tier) => [
							tier.severity,
							`${tier.factor}x`,
							`${tier.longWindow} and ${tier.shortWindow}`,
							tier.breached ? "yes" : "no",
						]),
					),
				],
				next: [
					...ruleNext(output.slo),
					doc.next(
						"diagnose_service",
						{ service: output.slo.serviceName },
						`what is wrong with ${output.slo.serviceName}`,
					),
				],
			}
		},
	})

	server.define({
		name: "create_slo",
		title: "Create SLO",
		description: `Define an SLO on one service's entry-point spans. sli=availability counts spans that are not errors as good; sli=latency counts spans faster than threshold_ms. target_percent is the good share to hold (50 to 99.999, e.g. 99.9) over window_days. ${BURN_TIER_TEXT} Org admins and engineers only.`,
		parameters: Schema.Struct({
			name: P.text("A label for the SLO, unique among the org's SLOs"),
			service: P.text("The service whose entry-point spans count (exact `service.name`)"),
			sli: P.oneOf(SLI_KINDS, "What makes a span good: not an error, or faster than threshold_ms"),
			target_percent: P.number("Target share of good spans in percent, 50 to 99.999 (e.g. 99.9)"),
			...sloParameters,
		}),
		aliases: P.SERVICE_ALIASES,
		output: SloMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Adding an SLO"],
		handler: Effect.fn("McpTool.createSlo")(function* (params) {
			const tenant = yield* canManage("create_slo")
			const service = yield* SlosService
			const sli = yield* buildSli(params.sli, params.threshold_ms)
			const windowDays = yield* decodeWindowDays(params.window_days)
			const alerting = yield* alertingInput(params)
			const created = yield* service
				.create(tenant.orgId, {
					name: params.name,
					serviceName: params.service,
					sli,
					targetPercent: params.target_percent,
					...(params.description === undefined ? undefined : { description: params.description }),
					...(params.environments === undefined
						? undefined
						: { environments: params.environments }),
					...(windowDays === undefined ? undefined : { windowDays }),
					...(alerting === undefined ? undefined : { alerting }),
					createdBy: tenant.userId,
				})
				.pipe(Effect.mapError(toMcpSloError("create_slo")))
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.slo.id": created.id })
			return { action: "created" as const, slo: toSloConfigRow(created) }
		}),
		render: (output) => renderMutation("SLO created", output.slo),
	})

	server.define({
		name: "update_slo",
		title: "Update SLO",
		description:
			"Change an SLO: its name, description, service, environments, SLI, target, window, or its burn-rate alerting (alerting_enabled, destinations per tier). Fields left out keep their value. Changing threshold_ms alone keeps a latency SLI. Org admins and engineers only.",
		parameters: Schema.Struct({
			slo: P.text("The SLO's name or id (list_slos lists them)"),
			name: P.optionalText("A new name"),
			service: P.service("A new service (exact `service.name`)"),
			sli: P.optionalOneOf(SLI_KINDS, "A new SLI: not an error, or faster than threshold_ms"),
			target_percent: P.optionalNumber("A new target share of good spans in percent, 50 to 99.999"),
			...sloParameters,
		}),
		aliases: P.SERVICE_ALIASES,
		output: SloMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Updating an SLO"],
		handler: Effect.fn("McpTool.updateSlo")(function* (params) {
			const tenant = yield* canManage("update_slo")
			const service = yield* SlosService
			const current = yield* resolveSlo("update_slo", tenant.orgId, params.slo)
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.slo.id": current.id })
			const sliKind = params.sli ?? (params.threshold_ms === undefined ? undefined : current.sli._tag)
			const sli = sliKind === undefined ? undefined : yield* buildSli(sliKind, params.threshold_ms)
			const windowDays = yield* decodeWindowDays(params.window_days)
			const alerting = yield* alertingInput(params)
			const updated = yield* service
				.update(tenant.orgId, current.id, {
					...(params.name === undefined ? undefined : { name: params.name }),
					// An empty description removes it.
					...(params.description === undefined
						? undefined
						: { description: params.description === "" ? null : params.description }),
					...(params.service === undefined ? undefined : { serviceName: params.service }),
					...(params.environments === undefined
						? undefined
						: { environments: params.environments }),
					...(sli === undefined ? undefined : { sli }),
					...(params.target_percent === undefined
						? undefined
						: { targetPercent: params.target_percent }),
					...(windowDays === undefined ? undefined : { windowDays }),
					...(alerting === undefined ? undefined : { alerting }),
					updatedBy: tenant.userId,
				})
				.pipe(Effect.mapError(toMcpSloError("update_slo")))
			return { action: "updated" as const, slo: toSloConfigRow(updated) }
		}),
		render: (output) => renderMutation("SLO updated", output.slo),
	})

	server.define({
		name: "delete_slo",
		title: "Delete SLO",
		description:
			"Delete an SLO and its burn-rate alert rule. Irreversible; requires confirm=true. To silence it instead, update_slo alerting_enabled=false. Org admins and engineers only.",
		parameters: Schema.Struct({
			slo: P.text("The SLO's name or id"),
			confirm: P.flag("Must be true. There is no undo."),
		}),
		output: DeleteSloOutput,
		hints: { readOnly: false, destructive: true, idempotent: false },
		phrases: ["Deleting an SLO"],
		handler: Effect.fn("McpTool.deleteSlo")(function* (params) {
			// A member is refused before being asked to confirm, as create and update are.
			const tenant = yield* canManage("delete_slo")
			if (params.confirm !== true) {
				return yield* new McpInvalidInputError({
					message: `Deletion not confirmed. Re-call delete_slo with confirm=true to delete "${params.slo}", or silence it with update_slo alerting_enabled=false.`,
					parameter: "confirm",
				})
			}
			const service = yield* SlosService
			const slo = yield* resolveSlo("delete_slo", tenant.orgId, params.slo)
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.slo.id": slo.id })
			yield* service.delete(tenant.orgId, slo.id).pipe(Effect.mapError(toMcpSloError("delete_slo")))
			return { deleted: true, id: slo.id, name: slo.name }
		}),
		render: (output) => ({
			title: "SLO deleted",
			blocks: [doc.text(`Deleted "${output.name}" (${output.id}) and its burn-rate alert rule.`)],
			next: [doc.next("list_slos", {}, "the SLOs that remain")],
		}),
	})
}
