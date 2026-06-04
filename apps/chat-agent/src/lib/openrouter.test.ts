import { describe, expect, it } from "vitest"
import { createOpenRouterHeaders, createOpenRouterRequestOptions } from "./openrouter"

describe("createOpenRouterHeaders", () => {
	it("builds OpenRouter app attribution headers", () => {
		expect(
			createOpenRouterHeaders({
				appBaseUrl: " https://app.maple.dev ",
				appTitle: " Maple Observability ",
			}),
		).toEqual({
			"HTTP-Referer": "https://app.maple.dev",
			"X-OpenRouter-Title": "Maple Observability",
		})
	})

	it("omits a blank referer and falls back to the Maple title", () => {
		expect(createOpenRouterHeaders({ appBaseUrl: "  " })).toEqual({
			"X-OpenRouter-Title": "Maple",
		})
	})
})

describe("createOpenRouterRequestOptions", () => {
	it("builds provider options for OpenRouter Broadcast trace correlation", () => {
		expect(
			createOpenRouterRequestOptions({
				traceId: " turn-123 ",
				traceName: "Maple Chat Agent",
				spanName: "Agent Turn",
				generationName: "Chat Turn",
				parentSpanId: "parent-456",
				sessionId: "org_123:tab_abc",
				userId: "user_789",
				orgId: "org_123",
				operation: "chat.turn",
				mode: "dashboard_builder",
				environment: "stg",
				isByok: true,
			}),
		).toEqual({
			providerOptions: {
				openrouter: {
					session_id: "org_123:tab_abc",
					user: "user_789",
					trace: {
						trace_id: "turn-123",
						trace_name: "Maple Chat Agent",
						span_name: "Agent Turn",
						generation_name: "Chat Turn",
						parent_span_id: "parent-456",
						orgId: "org_123",
						operation: "chat.turn",
						mode: "dashboard_builder",
						environment: "stg",
						isByok: true,
					},
				},
			},
		})
	})

	it("does not include blank optional metadata", () => {
		expect(
			createOpenRouterRequestOptions({
				traceId: "turn-123",
				sessionId: " ",
				orgId: "org_123",
				mode: "",
			}),
		).toEqual({
			providerOptions: {
				openrouter: {
					trace: {
						trace_id: "turn-123",
						trace_name: "Maple AI Chat",
						generation_name: "OpenRouter Generation",
						orgId: "org_123",
					},
				},
			},
		})
	})

	it("requires a non-empty trace id", () => {
		expect(() => createOpenRouterRequestOptions({ traceId: " " })).toThrow(
			"OpenRouter traceId is required",
		)
	})
})
