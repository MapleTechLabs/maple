import { describe, expect, it } from "vitest"

import { cloudShellUrl, gcpLogState } from "./gcp-connector-state"

const RECEIVED_AT = "2026-10-08T09:12:00.000Z"

describe("gcpLogState", () => {
	it("waits until the first log arrives", () => {
		expect(gcpLogState({ last_log_received_at: null, last_log_error: null })).toEqual({
			kind: "waiting",
		})
	})

	it("is receiving once a log was accepted", () => {
		expect(gcpLogState({ last_log_received_at: RECEIVED_AT, last_log_error: null })).toEqual({
			kind: "receiving",
			lastLogReceivedAt: RECEIVED_AT,
		})
	})

	it("reports a rejected push before any log was accepted", () => {
		expect(gcpLogState({ last_log_received_at: null, last_log_error: "invalid secret" })).toEqual({
			kind: "error",
			error: "invalid secret",
			lastLogReceivedAt: null,
		})
	})

	it("prefers the error over an earlier accepted log and keeps its time", () => {
		expect(
			gcpLogState({ last_log_received_at: RECEIVED_AT, last_log_error: "payload too large" }),
		).toEqual({ kind: "error", error: "payload too large", lastLogReceivedAt: RECEIVED_AT })
	})
})

describe("cloudShellUrl", () => {
	it("opens the console on the project with Cloud Shell attached", () => {
		expect(cloudShellUrl("acme-prod")).toBe(
			"https://console.cloud.google.com/?cloudshell=true&project=acme-prod",
		)
	})
})
