/**
 * Changes to alert destinations: create an email destination, rename or switch one off, delete
 * one, or send a test notification. Engineers and admins only, like the REST routes.
 *
 * Every other destination type is created from a credential (a webhook URL, a routing key, a bot
 * token) and those stay in Alerts > Destinations, so no secret passes through a model. A stored
 * credential is kept by an update here and never read back.
 */
import { Effect, Schema, Array as Arr } from "effect"
import {
	type AlertDestinationDocument,
	AlertDestinationUpdateRequest,
	EmailAlertDestinationConfig,
	type OrgId,
} from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import type { AlertDestinationRow } from "@maple/domain/mcp-outputs"
import { UserId } from "@maple/primitives"
import { AlertDestinationsService } from "@maple/backend/services/alerts/AlertDestinationsService"
import { McpInvalidInputError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../tenant"
import { toMcpHttpError } from "../lib/map-http-error"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { toolAudit } from "../lib/tool-audit"

const TOOL = "manage_alert_destination"

/** The types a model can create: the ones made from workspace members, not from a credential. */
const CREATABLE_TYPES = ["email"] as const

const toMcpError = toMcpHttpError(TOOL)

type Row = typeof AlertDestinationRow.Type

const toRow = (destination: AlertDestinationDocument): Row => ({
	id: destination.id,
	publicId: encodePublicId(PublicIdPrefixes.alertDestination, destination.id),
	name: destination.name,
	type: destination.type,
	enabled: destination.enabled,
	summary: destination.summary,
	channelLabel: destination.channelLabel,
	lastTestedAt: destination.lastTestedAt,
	lastTestError: destination.lastTestError,
	disabledReason: destination.disabledReason ?? null,
	createdAt: destination.createdAt,
	updatedAt: destination.updatedAt,
})

/** A destination by its id (`dest_…` or UUID) or exact name, as list_alert_destinations shows them. */
const resolveDestination = (orgId: OrgId, ref: string) =>
	Effect.gen(function* () {
		const destinations = yield* AlertDestinationsService
		const listed = yield* destinations.listDestinations(orgId).pipe(Effect.mapError(toMcpError))
		const matches = Arr.filter(
			listed.destinations,
			(destination) =>
				destination.id === ref ||
				encodePublicId(PublicIdPrefixes.alertDestination, destination.id) === ref ||
				destination.name === ref,
		)
		const [destination] = matches
		if (destination === undefined) {
			return yield* new McpInvalidInputError({
				message: `No alert destination named "${ref}". list_alert_destinations lists them with their ids.`,
				parameter: "destination",
			})
		}
		if (matches.length > 1) {
			return yield* new McpInvalidInputError({
				message: `${matches.length} alert destinations are named "${ref}"; pass one's id instead: ${Arr.join(
					Arr.map(matches, (match) => match.id),
					", ",
				)}.`,
				parameter: "destination",
			})
		}
		return destination
	})

const decodeUserId = Schema.decodeUnknownEffect(UserId)

/** `me` is the caller; anything else is a workspace member's Maple user id. */
const recipientIds = (recipients: ReadonlyArray<string>, caller: UserId) =>
	Effect.forEach(recipients, (recipient) =>
		recipient === "me"
			? Effect.succeed(caller)
			: decodeUserId(recipient).pipe(
					Effect.mapError(
						() =>
							new McpInvalidInputError({
								message: `"${recipient}" is not a Maple user id. Pass \`me\` or a workspace member's user id.`,
								parameter: "recipients",
							}),
					),
				),
	)

/** Email needs the member directory, which a deployment without an auth provider does not have. */
const directoryMissing = () =>
	new McpUnavailableError({
		message:
			"Email destinations need the workspace member directory, which this Maple deployment does not have. Use a webhook or chat destination, added in Alerts > Destinations.",
		capability: "member_directory",
	})

const renderDestination = (title: string, row: Row) => ({
	title,
	notices: row.enabled
		? []
		: [
				`"${row.name}" is off: rules that list it deliver nothing to it. ${TOOL} action=update enabled=true turns it back on.`,
			],
	blocks: [
		doc.fields([
			["Name", row.name],
			["Id", row.id],
			["REST id", row.publicId],
			["Type", row.type],
			["Target", row.channelLabel ?? row.summary],
			["Enabled", row.enabled ? "yes" : row.disabledReason ? `no (${row.disabledReason})` : "no"],
			["Last test error", row.lastTestError ?? undefined],
		]),
	],
	next: [
		doc.next("manage_alert_destination", { action: "test", destination: row.id }, "check it delivers"),
		doc.next(
			"list_alert_rules",
			{},
			"the rules to route here with update_alert_rule add_destination_ids",
		),
	],
})

export function registerAlertDestinationTools(server: McpToolRegistrar) {
	server
		.family({
			name: TOOL,
			title: "Manage Alert Destination",
			description:
				"Create, change, delete or test an alert destination: where alert rules, SLOs and uptime monitors send notifications (list_alert_destinations lists them). Org admins and engineers only.",
			phrases: ["Managing an alert destination"],
		})
		.action("create", {
			description:
				"Add an email destination that notifies workspace members. Every other type (webhook, PagerDuty, Discord, Telegram, Google Chat, Microsoft Teams, incident.io, a Slack or Discord channel, Linear) is created from a credential or a connected workspace in Alerts > Destinations; send the user there for those. Route a rule to the new destination with update_alert_rule add_destination_ids.",
			parameters: Schema.Struct({
				name: P.text("A label for the destination, e.g. `On-call email`"),
				type: P.oneOf(CREATABLE_TYPES, "The destination type"),
				recipients: P.optionalList(
					"Who to email: `me` for the caller, or workspace members' Maple user ids (at most 10). Default `me`",
				),
			}),
			hints: { readOnly: false, destructive: false, idempotent: false },
			permission: "alerts:manage",
			handler: Effect.fn("McpTool.createAlertDestination")(function* (params) {
				const tenant = yield* CurrentMcpTenant
				const destinations = yield* AlertDestinationsService
				const memberUserIds = yield* recipientIds(params.recipients ?? ["me"], tenant.userId)
				const request = yield* Schema.decodeEffect(EmailAlertDestinationConfig)({
					type: params.type,
					name: params.name,
					memberUserIds,
				}).pipe(
					Effect.mapError(
						() =>
							new McpInvalidInputError({
								message: "An email destination needs a name and 1 to 10 recipients.",
								parameter: "recipients",
							}),
					),
				)
				const created = yield* destinations
					.createDestination(request)
					.pipe(
						Effect.catchTag(
							"@maple/http/errors/AlertMemberDirectoryNotConfiguredError",
							directoryMissing,
						),
						Effect.mapError((error) =>
							Schema.is(McpUnavailableError)(error) ? error : toMcpError(error),
						),
					)
				yield* Effect.annotateCurrentSpan({
					orgId: tenant.orgId,
					"maple.alert.destination_id": created.id,
				})
				const audit = yield* toolAudit
				yield* audit.record({
					...audit.who,
					action: "alert_destination.created",
					resourceId: created.id,
					metadata: { name: created.name, type: created.type, ...audit.origin },
				})
				return { action: "created" as const, destination: toRow(created) }
			}),
			render: (output) => renderDestination("Alert destination created", output.destination),
		})
		.action("update", {
			description:
				"Change an alert destination: rename it, turn it off (enabled=false) or back on, or replace an email destination's recipients. Fields left out keep their value and a stored credential is kept. A new webhook URL, key or channel is set in Alerts > Destinations.",
			parameters: Schema.Struct({
				destination: P.text("The destination's name or id (list_alert_destinations lists them)"),
				name: P.optionalText("A new name"),
				enabled: P.optionalFlag(
					"false stops delivery to it without removing it from rules; true resumes",
				),
				recipients: P.optionalList(
					"Email destinations only: the new recipients, `me` or workspace members' Maple user ids",
				),
			}),
			hints: { readOnly: false, destructive: false, idempotent: true },
			permission: "alerts:manage",
			handler: Effect.fn("McpTool.updateAlertDestination")(function* (params) {
				const tenant = yield* CurrentMcpTenant
				const destinations = yield* AlertDestinationsService
				const current = yield* resolveDestination(tenant.orgId, params.destination)
				if (
					params.name === undefined &&
					params.enabled === undefined &&
					params.recipients === undefined
				) {
					return yield* new McpInvalidInputError({
						message: "Nothing to change: pass name, enabled or recipients.",
						parameter: "name",
					})
				}
				if (params.recipients !== undefined && current.type !== "email") {
					return yield* new McpInvalidInputError({
						message: `"${current.name}" is a ${current.type} destination and has no recipients; where it delivers is changed in Alerts > Destinations.`,
						parameter: "recipients",
					})
				}
				const memberUserIds =
					params.recipients === undefined
						? undefined
						: yield* recipientIds(params.recipients, tenant.userId)
				const request = yield* Schema.decodeEffect(AlertDestinationUpdateRequest)({
					type: current.type,
					...(params.name === undefined ? undefined : { name: params.name }),
					...(params.enabled === undefined ? undefined : { enabled: params.enabled }),
					...(memberUserIds === undefined ? undefined : { memberUserIds }),
				}).pipe(
					Effect.mapError(
						() =>
							new McpInvalidInputError({
								message:
									"A name cannot be blank, and an email destination takes 1 to 10 recipients.",
								parameter: params.recipients === undefined ? "name" : "recipients",
							}),
					),
				)
				const updated = yield* destinations
					.updateDestination(current.id, request)
					.pipe(
						Effect.catchTag(
							"@maple/http/errors/AlertMemberDirectoryNotConfiguredError",
							directoryMissing,
						),
						Effect.mapError((error) =>
							Schema.is(McpUnavailableError)(error) ? error : toMcpError(error),
						),
					)
				yield* Effect.annotateCurrentSpan({
					orgId: tenant.orgId,
					"maple.alert.destination_id": updated.id,
				})
				const audit = yield* toolAudit
				yield* audit.record({
					...audit.who,
					action: "alert_destination.updated",
					resourceId: updated.id,
					metadata: {
						name: updated.name,
						type: updated.type,
						enabled: updated.enabled,
						...audit.origin,
					},
				})
				return { action: "updated" as const, destination: toRow(updated) }
			}),
			render: (output) => renderDestination("Alert destination updated", output.destination),
		})
		.action("delete", {
			description:
				"Delete an alert destination. list_alert_destinations shows what uses each one, and the delete checks again: it is refused while an alert rule (an SLO's or uptime monitor's included) or an escalation chain still routes to it, and the refusal names them. update_alert_rule remove_destination_ids takes it off a rule. Irreversible; requires confirm=true, and only for a destination the user named: when they did not say which, list them and ask. To stop delivery and keep it, action=update enabled=false.",
			parameters: Schema.Struct({
				destination: P.text("The destination's name or id"),
				confirm: P.flag("Must be true. There is no undo."),
			}),
			hints: { readOnly: false, destructive: true, idempotent: false },
			permission: "alerts:manage",
			handler: Effect.fn("McpTool.deleteAlertDestination")(function* (params) {
				const tenant = yield* CurrentMcpTenant
				const destinations = yield* AlertDestinationsService
				if (params.confirm !== true) {
					return yield* new McpInvalidInputError({
						message: `Deletion not confirmed. Re-call ${TOOL} action=delete with confirm=true to delete "${params.destination}", or turn it off with ${TOOL} action=update enabled=false.`,
						parameter: "confirm",
					})
				}
				const current = yield* resolveDestination(tenant.orgId, params.destination)
				yield* destinations.deleteDestination(current.id).pipe(
					Effect.catchTag("@maple/http/errors/AlertDestinationInUseError", (error) =>
						Effect.fail(
							new McpInvalidInputError({
								message: `"${current.name}" is still in use. ${error.message}. Take it off each one first (update_alert_rule remove_destination_ids=["${current.id}"]), then delete it.`,
								parameter: "destination",
							}),
						),
					),
					Effect.mapError((error) =>
						Schema.is(McpInvalidInputError)(error) ? error : toMcpError(error),
					),
				)
				yield* Effect.annotateCurrentSpan({
					orgId: tenant.orgId,
					"maple.alert.destination_id": current.id,
				})
				const audit = yield* toolAudit
				yield* audit.record({
					...audit.who,
					action: "alert_destination.deleted",
					resourceId: current.id,
					metadata: { name: current.name, type: current.type, ...audit.origin },
				})
				return { deleted: true, id: current.id, name: current.name }
			}),
			render: (output) => ({
				title: "Alert destination deleted",
				blocks: [doc.text(`Deleted "${output.name}" (${output.id}).`)],
				next: [doc.next("list_alert_destinations", {}, "the destinations that remain")],
			}),
		})
		.action("test", {
			description:
				"Run a destination's test and report what it did; the result is also recorded on the destination (last test error). For most types this sends a real message to a real channel. A Linear test only checks access to the team, and a chat workspace with alert notifications off posts nothing: Result says which happened, so relay it and do not say a message was sent unless it does. Email destinations are tested from Alerts > Destinations.",
			parameters: Schema.Struct({
				destination: P.text("The destination's name or id"),
			}),
			hints: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
			permission: "alerts:manage",
			handler: Effect.fn("McpTool.testAlertDestination")(function* (params) {
				const tenant = yield* CurrentMcpTenant
				const destinations = yield* AlertDestinationsService
				const current = yield* resolveDestination(tenant.orgId, params.destination)
				if (current.type === "email") {
					return yield* new McpUnavailableError({
						message: `"${current.name}" is an email destination, which this tool cannot send to. Send its test from Alerts > Destinations.`,
						capability: "email_delivery",
					})
				}
				yield* Effect.annotateCurrentSpan({
					orgId: tenant.orgId,
					"maple.alert.destination_id": current.id,
					"maple.alert.destination_type": current.type,
				})
				// A provider refusing the test is the answer, not a failure of the call.
				const outcome = yield* destinations
					.testDestination(current.id)
					.pipe(
						Effect.map((sent) => ({ passed: sent.success, message: sent.message })),
						Effect.catchTags({
							"@maple/http/errors/AlertDeliveryError": (error) =>
								Effect.succeed({ passed: false, message: error.message }),
							"@maple/http/errors/AlertDeliveryAuthError": (error) =>
								Effect.succeed({ passed: false, message: error.message }),
							"@maple/http/errors/AlertDeliveryTargetMissingError": (error) =>
								Effect.succeed({ passed: false, message: error.message }),
							"@maple/http/errors/AlertDeliveryRejectedError": (error) =>
								Effect.succeed({ passed: false, message: error.message }),
						}),
						Effect.mapError(toMcpError),
					)
				yield* Effect.annotateCurrentSpan({ "maple.alert.test_passed": outcome.passed })
				return {
					destination: {
						...toRow(current),
						lastTestError: outcome.passed ? null : outcome.message,
					},
					...outcome,
				}
			}),
			render: (output) => ({
				title: output.passed ? "Destination test passed" : "Destination test failed",
				notices: output.passed
					? []
					: [
							`"${output.destination.name}" did not accept the test. Alerts routed to it are failing the same way until its target or credential is fixed in Alerts > Destinations.`,
						],
				blocks: [
					doc.fields([
						["Destination", output.destination.name],
						["Type", output.destination.type],
						["Target", output.destination.channelLabel ?? output.destination.summary],
						["Result", output.message],
					]),
				],
				next: [doc.next("list_alert_destinations", {}, "every destination's delivery health")],
			}),
		})
}
