import { describe, expect, it } from "vitest"
import { Exit, Schema } from "effect"
import {
	AlertDestinationCreateRequest,
	AlertNotificationTemplate,
	AlertRuleUpsertRequest,
	AlertSignalType,
} from "./alerts"

describe("alert signal compatibility", () => {
	it("rejects the retired metric signal", () => {
		expect(Exit.isFailure(Schema.decodeUnknownExit(AlertSignalType)("metric"))).toBe(true)
	})
})

describe("AlertDestinationCreateRequest", () => {
	const decodeExit = Schema.decodeUnknownExit(AlertDestinationCreateRequest)

	it("rejects the retired slack-bot destination type", () => {
		const result = decodeExit({
			type: "slack-bot",
			name: "Ops Slack",
			enabled: true,
			channelId: "C123",
		})

		expect(Exit.isFailure(result)).toBe(true)
	})
})

describe("AlertNotificationTemplate", () => {
	const decodeExit = Schema.decodeUnknownExit(AlertNotificationTemplate)

	it("rejects a title longer than the 4000-char cap", () => {
		const result = decodeExit({ title: "x".repeat(4001) })
		expect(Exit.isFailure(result)).toBe(true)
	})
})

describe("AlertRuleUpsertRequest", () => {
	const decodeExit = Schema.decodeUnknownExit(AlertRuleUpsertRequest)

	const baseRule = {
		name: "Checkout errors",
		severity: "critical" as const,
		signalType: "error_rate" as const,
		comparator: "gt" as const,
		threshold: 0.05,
		windowMinutes: 5,
		destinationIds: [],
	}

	it("rejects alert windows longer than 24 hours", () => {
		expect(Exit.isFailure(decodeExit({ ...baseRule, windowMinutes: 24 * 60 + 1 }))).toBe(true)
	})
})
