import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createOpenRouterHeaders, createOpenRouterRequestOptions } from "./openrouter"

describe("createOpenRouterHeaders", () => {
	it("builds OpenRouter app attribution headers", () => {
		assert.deepEqual(
			createOpenRouterHeaders({
				appBaseUrl: " https://app.maple.dev ",
				appTitle: " Maple Observability ",
			}),
			{
				"HTTP-Referer": "https://app.maple.dev",
				"X-OpenRouter-Title": "Maple Observability",
			},
		)
	})

	it("omits a blank referer and falls back to the Maple title", () => {
		assert.deepEqual(createOpenRouterHeaders({ appBaseUrl: "  " }), {
			"X-OpenRouter-Title": "Maple",
		})
	})
})

describe("createOpenRouterRequestOptions", () => {
	it("builds provider options for OpenRouter Broadcast trace correlation", () => {
		assert.deepEqual(
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
			{
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
			},
		)
	})

	it("does not include blank optional metadata", () => {
		assert.deepEqual(
			createOpenRouterRequestOptions({
				traceId: "turn-123",
				sessionId: " ",
				orgId: "org_123",
				mode: "",
			}),
			{
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
			},
		)
	})

	it("requires a non-empty trace id", () => {
		assert.throws(() => createOpenRouterRequestOptions({ traceId: " " }), {
			message: "OpenRouter traceId is required",
		})
	})
})
