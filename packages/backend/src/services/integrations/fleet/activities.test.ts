import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Option } from "effect"
import { type FleetActivity, fleetActivityCategory, fleetActivityToEvent } from "./activities"

const activity = (overrides: Partial<FleetActivity>): FleetActivity => ({
	id: 41,
	created_at: "2026-11-19T10:00:00Z",
	type: "edited_agent_options",
	actor_full_name: "Jane Admin",
	actor_id: 3,
	actor_email: "jane@acme.test",
	fleet_initiated: false,
	details: null,
	...overrides,
})

const SOURCE = { account: "Acme Corp", server: "fleet.example.com" }

const eventOf = (overrides: Partial<FleetActivity>) =>
	Option.getOrThrow(fleetActivityToEvent(activity(overrides), SOURCE))

describe("fleetActivityToEvent", () => {
	it("keeps who wiped which device, under the Fleet account", () => {
		const event = eventOf({
			type: "wiped_host",
			details: { host_id: 12, host_display_name: "jane-macbook" },
		})
		assert.deepStrictEqual(
			{
				provider: event.provider,
				providerEventId: event.providerEventId,
				account: event.account,
				occurredAtMs: event.occurredAtMs,
				actor: event.actor,
				action: event.action,
				category: event.category,
				outcome: event.outcome,
				target: event.target,
			},
			{
				provider: "fleet",
				providerEventId: "fleet.example.com:41",
				account: "Acme Corp",
				occurredAtMs: Date.parse("2026-11-19T10:00:00Z"),
				actor: { type: "user", id: "3", name: "Jane Admin", email: "jane@acme.test" },
				action: "wiped_host",
				category: "resource",
				outcome: "success",
				target: { type: "host", id: "12", name: "jane-macbook" },
			},
		)
	})

	it("reads a failed login as a failure by an unproven address, with its IP", () => {
		const event = eventOf({
			type: "user_failed_login",
			actor_id: null,
			actor_full_name: null,
			actor_email: null,
			details: { email: "mallory@evil.test", public_ip: "203.0.113.9" },
		})
		assert.deepStrictEqual(
			[event.category, event.outcome, event.actor, event.originIp],
			["authentication", "failure", { type: "unknown", email: "mallory@evil.test" }, "203.0.113.9"],
		)
	})

	it("names Fleet itself as the actor of an automation", () => {
		const event = eventOf({ type: "ran_script", fleet_initiated: true, actor_id: null })
		assert.deepStrictEqual(event.actor, { type: "system", name: "Fleet" })
	})

	// Shapes as a Fleet 4.95 server sends them.
	it("names Fleet as the actor of a device enrolling itself, as a resource event", () => {
		const event = eventOf({
			type: "fleet_enrolled",
			actor_full_name: null,
			actor_email: "",
			actor_id: null,
			details: { host_id: 1, host_serial: "C02XX0000", host_display_name: "Studio Mac" },
		})
		assert.deepStrictEqual(
			[event.actor, event.category, event.target],
			[{ type: "system", name: "Fleet" }, "resource", { type: "host", id: "1", name: "Studio Mac" }],
		)
	})

	it("names the label a label activity is about", () => {
		const event = eventOf({
			type: "created_label",
			details: { label_id: 21, label_name: "Debian-based Linux hosts" },
		})
		assert.deepStrictEqual(event.target, { type: "label", id: "21", name: "Debian-based Linux hosts" })
	})

	it("drops an activity whose time does not parse", () => {
		assert.isTrue(Option.isNone(fleetActivityToEvent(activity({ created_at: "yesterday" }), SOURCE)))
	})
})

describe("fleetActivityCategory", () => {
	it("sorts the types an audit rule is written against", () => {
		assert.deepStrictEqual(
			Arr.map(
				[
					"changed_user_global_role",
					"created_user",
					"edited_enroll_secrets",
					"read_host_disk_encryption_key",
					"created_policy",
					"applied_spec_team",
					"locked_host",
					"installed_software",
					"some_new_activity",
				],
				fleetActivityCategory,
			),
			[
				"permission",
				"membership",
				"credential",
				"data_access",
				"configuration",
				"configuration",
				"resource",
				"resource",
				"other",
			],
		)
	})
})
