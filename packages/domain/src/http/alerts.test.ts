import { describe, expect, it } from "vitest"
import { Exit, Schema } from "effect"
import {
	AlertDestinationCreateRequest,
	PagerDutyAlertDestinationConfig,
	SlackAlertDestinationConfig,
	WebhookAlertDestinationConfig,
} from "./alerts"

describe("AlertDestinationCreateRequest", () => {
	const encode = Schema.encodeUnknownSync(AlertDestinationCreateRequest)

	// `AlertDestinationCreateRequest` is a `Schema.Union` of `Schema.Class`
	// instances, so `encodeUnknownSync` requires class instances on the input
	// side and produces the plain wire-format object on the output side.
	// These tests assert the encoded wire shape matches what HTTP clients
	// see on the wire.
	it("encodes slack destination instances to the plain wire shape", () => {
		expect(
			encode(
				new SlackAlertDestinationConfig({
					type: "slack",
					name: "Ops Slack",
					enabled: true,
					webhookUrl: "https://hooks.slack.com/services/T/B/X",
					channelLabel: "#ops-alerts",
				}),
			),
		).toEqual({
			type: "slack",
			name: "Ops Slack",
			enabled: true,
			webhookUrl: "https://hooks.slack.com/services/T/B/X",
			channelLabel: "#ops-alerts",
		})
	})

	it("encodes pagerduty and webhook destination instances to the plain wire shape", () => {
		expect(
			encode(
				new PagerDutyAlertDestinationConfig({
					type: "pagerduty",
					name: "PagerDuty",
					enabled: true,
					integrationKey: "integration-key",
				}),
			),
		).toEqual({
			type: "pagerduty",
			name: "PagerDuty",
			enabled: true,
			integrationKey: "integration-key",
		})

		expect(
			encode(
				new WebhookAlertDestinationConfig({
					type: "webhook",
					name: "Webhook",
					enabled: true,
					url: "https://example.com/alerts",
					signingSecret: "secret",
				}),
			),
		).toEqual({
			type: "webhook",
			name: "Webhook",
			enabled: true,
			url: "https://example.com/alerts",
			signingSecret: "secret",
		})
	})

	const decode = Schema.decodeUnknownSync(AlertDestinationCreateRequest)
	const decodeExit = Schema.decodeUnknownExit(AlertDestinationCreateRequest)

	// Decode goes the other direction: plain wire-format objects in, class
	// instances out. The union discriminates on `type`.
	it("decodes a slack wire object into a SlackAlertDestinationConfig instance", () => {
		const decoded = decode({
			type: "slack",
			name: "Ops Slack",
			enabled: true,
			webhookUrl: "https://hooks.slack.com/services/T/B/X",
			channelLabel: "#ops-alerts",
		})

		expect(decoded).toBeInstanceOf(SlackAlertDestinationConfig)
		expect(decoded).toMatchObject({
			type: "slack",
			name: "Ops Slack",
			enabled: true,
			webhookUrl: "https://hooks.slack.com/services/T/B/X",
			channelLabel: "#ops-alerts",
		})
	})

	it("decodes a pagerduty wire object into a PagerDutyAlertDestinationConfig instance", () => {
		const decoded = decode({
			type: "pagerduty",
			name: "PagerDuty",
			enabled: true,
			integrationKey: "integration-key",
		})

		expect(decoded).toBeInstanceOf(PagerDutyAlertDestinationConfig)
		expect(decoded).toMatchObject({
			type: "pagerduty",
			name: "PagerDuty",
			integrationKey: "integration-key",
		})
	})

	it("decodes a webhook wire object into a WebhookAlertDestinationConfig instance", () => {
		const decoded = decode({
			type: "webhook",
			name: "Webhook",
			enabled: true,
			url: "https://example.com/alerts",
			signingSecret: "secret",
		})

		expect(decoded).toBeInstanceOf(WebhookAlertDestinationConfig)
		expect(decoded).toMatchObject({
			type: "webhook",
			name: "Webhook",
			url: "https://example.com/alerts",
			signingSecret: "secret",
		})
	})

	it("fails to decode an unknown destination type", () => {
		const result = decodeExit({
			type: "carrier-pigeon",
			name: "Pigeon",
			enabled: true,
		})

		expect(Exit.isFailure(result)).toBe(true)
	})

	it("fails to decode a slack destination missing the required webhookUrl", () => {
		const result = decodeExit({
			type: "slack",
			name: "Ops Slack",
			enabled: true,
			channelLabel: "#ops-alerts",
		})

		expect(Exit.isFailure(result)).toBe(true)
	})
})
