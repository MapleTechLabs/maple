import { assert, describe, it } from "@effect/vitest"
import { AlertIncidentEventDocument, AlertIncidentEventId, AlertIncidentId, UserId } from "@maple/domain/http"
import { Schema, Array as Arr } from "effect"
import { mergePagesIntoEvents, type AlertIncidentPageEntry } from "./AlertIncidentPagesService"

const INCIDENT = Schema.decodeSync(AlertIncidentId)("00000000-0000-4000-8000-000000000031")
const asEventId = Schema.decodeSync(AlertIncidentEventId)
const asIso = Schema.decodeSync(AlertIncidentEventDocument.fields.createdAt)
const T0 = Date.parse("2026-11-06T10:00:00.000Z")

const ack = (id: string, at: number) =>
	new AlertIncidentEventDocument({
		id: asEventId(id),
		incidentId: INCIDENT,
		type: "acknowledged",
		actorUserId: null,
		actorName: "Dana Kim",
		source: "web",
		createdAt: asIso(new Date(at).toISOString()),
	})

const page = (id: string, at: number): AlertIncidentPageEntry => ({
	id,
	incidentId: INCIDENT,
	createdAt: at,
	page: {
		userId: Schema.decodeSync(UserId)("user_ben"),
		name: "Ben Brook",
		channel: "email",
		status: "sent",
		errorMessage: null,
	},
})

describe("mergePagesIntoEvents", () => {
	it("orders acks and pages by time, an ack first when both share a millisecond", () => {
		const events = mergePagesIntoEvents(
			[
				ack("00000000-0000-4000-8000-0000000000a1", T0 + 1000),
				ack("00000000-0000-4000-8000-0000000000a2", T0 + 3000),
			],
			[
				page("00000000-0000-4000-8000-0000000000b1", T0),
				page("00000000-0000-4000-8000-0000000000b2", T0 + 1000),
			],
		)
		assert.deepStrictEqual(
			Arr.map(events, (event) => [event.type, event.createdAt]),
			[
				["paged", new Date(T0).toISOString()],
				["acknowledged", new Date(T0 + 1000).toISOString()],
				["paged", new Date(T0 + 1000).toISOString()],
				["acknowledged", new Date(T0 + 3000).toISOString()],
			],
		)
		assert.strictEqual(events[0]?.page?.name, "Ben Brook")
	})
})
