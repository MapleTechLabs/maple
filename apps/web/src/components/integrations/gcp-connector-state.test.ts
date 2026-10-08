import { describe, expect, it } from "vitest"

import { Option } from "effect"
import {
	cloudShellUrl,
	gcpCreateRequest,
	gcpLogState,
	gcpScopeLabel,
	gcpSwitchLock,
	type GcpConnectorDraft,
} from "./gcp-connector-state"

const RECEIVED_AT = "2026-10-08T09:12:00.000Z"

describe("gcpLogState", () => {
	const logs = (last_log_received_at: string | null, last_log_error: string | null) =>
		gcpLogState({ logs_enabled: true, last_log_received_at, last_log_error })

	it("is off when log forwarding is switched off, whatever arrived earlier", () => {
		expect(
			gcpLogState({ logs_enabled: false, last_log_received_at: RECEIVED_AT, last_log_error: "x" }),
		).toEqual({ kind: "off" })
	})

	it("waits until the first log arrives", () => {
		expect(logs(null, null)).toEqual({ kind: "waiting" })
	})

	it("is receiving once a log was accepted", () => {
		expect(logs(RECEIVED_AT, null)).toEqual({ kind: "receiving", lastLogReceivedAt: RECEIVED_AT })
	})

	it("reports a rejected push before any log was accepted", () => {
		expect(logs(null, "invalid secret")).toEqual({
			kind: "error",
			error: "invalid secret",
			lastLogReceivedAt: null,
		})
	})

	it("prefers the error over an earlier accepted log and keeps its time", () => {
		expect(logs(RECEIVED_AT, "payload too large")).toEqual({
			kind: "error",
			error: "payload too large",
			lastLogReceivedAt: RECEIVED_AT,
		})
	})
})

describe("gcpSwitchLock", () => {
	const both = { logs_enabled: true, metrics_enabled: true }
	const logsOnly = { logs_enabled: true, metrics_enabled: false }
	const metricsOnly = { logs_enabled: false, metrics_enabled: true }

	it("leaves both switches free while both are on", () => {
		expect(gcpSwitchLock(both, "logs", true)).toBeNull()
		expect(gcpSwitchLock(both, "metrics", true)).toBeNull()
	})

	it("locks the last switch that is on", () => {
		expect(gcpSwitchLock(logsOnly, "logs", true)).toBe("last-on")
		expect(gcpSwitchLock(metricsOnly, "metrics", true)).toBe("last-on")
	})

	it("lets the other switch be turned on", () => {
		expect(gcpSwitchLock(logsOnly, "metrics", true)).toBeNull()
		expect(gcpSwitchLock(metricsOnly, "logs", true)).toBeNull()
	})

	it("locks metrics off when the deployment cannot read them", () => {
		expect(gcpSwitchLock(logsOnly, "metrics", false)).toBe("metrics-unavailable")
	})

	it("still lets metrics be turned off on such a deployment", () => {
		expect(gcpSwitchLock(both, "metrics", false)).toBeNull()
	})
})

describe("gcpScopeLabel", () => {
	it("names the scope kind and its id", () => {
		expect(gcpScopeLabel({ scope_type: "organization", scope_id: "123456789012" })).toBe(
			"Organization 123456789012",
		)
		expect(gcpScopeLabel({ scope_type: "project", scope_id: "acme-prod" })).toBe("Project acme-prod")
	})
})

describe("gcpCreateRequest", () => {
	const draft = (over: Partial<GcpConnectorDraft>): GcpConnectorDraft => ({
		scopeType: "project",
		scopeId: "",
		hostProjectId: "",
		...over,
	})
	const request = (over: Partial<GcpConnectorDraft>) => Option.getOrNull(gcpCreateRequest(draft(over)))

	it("sends a project as its own host project, trimmed", () => {
		expect(request({ scopeId: " acme-prod ", hostProjectId: "ignored-host" })).toEqual({
			scope_type: "project",
			scope_id: "acme-prod",
		})
	})

	it("rejects a project name or number as a project ID", () => {
		expect(request({ scopeId: "Acme Prod" })).toBeNull()
		expect(request({ scopeId: "123456789012" })).toBeNull()
		expect(request({ scopeId: "acme-prod-" })).toBeNull()
	})

	it("sends a folder or organization with its host project", () => {
		expect(
			request({
				scopeType: "organization",
				scopeId: "123456789012",
				hostProjectId: "acme-observability",
			}),
		).toEqual({
			scope_type: "organization",
			scope_id: "123456789012",
			project_id: "acme-observability",
		})
		expect(request({ scopeType: "folder", scopeId: "42", hostProjectId: "acme-observability" })).toEqual({
			scope_type: "folder",
			scope_id: "42",
			project_id: "acme-observability",
		})
	})

	it("needs a numeric ID and a host project for a folder or organization", () => {
		expect(request({ scopeType: "folder", scopeId: "my-folder", hostProjectId: "acme-prod" })).toBeNull()
		expect(request({ scopeType: "organization", scopeId: "123456789012" })).toBeNull()
		expect(
			request({ scopeType: "organization", scopeId: "123456789012", hostProjectId: "Acme" }),
		).toBeNull()
	})
})

describe("cloudShellUrl", () => {
	it("opens the console on the host project with Cloud Shell attached", () => {
		expect(cloudShellUrl("acme-prod")).toBe(
			"https://console.cloud.google.com/?cloudshell=true&project=acme-prod",
		)
	})
})
