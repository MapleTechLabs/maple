import { WorkerEntrypoint } from "cloudflare:workers"
import type {
	AiChatInput,
	AiChatCallbacks,
	AiToolDescriptor,
	AiToolCallbacks,
	InvokePlannerInput,
	InvokePlannerOutput,
	InvokeHypothesisInput,
	InvokeHypothesisOutput,
	InvokeValidatorInput,
	InvokeValidatorOutput,
} from "@maple/domain/ai-service"
interface Env {
	AI_SERVICE: {
		chat(input: AiChatInput, callbacks: AiChatCallbacks): Promise<void>
		plan(
			input: InvokePlannerInput,
			tools: ReadonlyArray<AiToolDescriptor>,
			callbacks: AiToolCallbacks,
		): Promise<InvokePlannerOutput>
		hypothesis(
			input: InvokeHypothesisInput,
			tools: ReadonlyArray<AiToolDescriptor>,
			callbacks: AiToolCallbacks,
		): Promise<InvokeHypothesisOutput>
		validate(
			input: InvokeValidatorInput,
			tools: ReadonlyArray<AiToolDescriptor>,
			callbacks: AiToolCallbacks,
		): Promise<InvokeValidatorOutput>
	}
}
const tools = [
	{
		name: "list_services",
		description: "List services",
		inputSchema: { type: "object", properties: {} },
		mutating: false,
	},
]
const pass = {
	orgId: "org_test",
	investigationId: "11111111-1111-4111-8111-111111111111",
	subject: { type: "freeform" as const, title: "Incident", prompt: "What happened?", contextRefs: [] },
	snapshot: null,
	deadlineAtMs: 0,
}
export default class Caller extends WorkerEntrypoint<Env> {
	async fetch(request: Request) {
		const mode = new URL(request.url).pathname
		const events: string[] = []
		const calls: string[] = []
		let usage = { input: 0, output: 0, cacheRead: 0 }
		const callbacks = {
			execute: async (name: string) => {
				calls.push(name)
				return { content: [{ type: "text" as const, text: "healthy" }] }
			},
			publish: async (batch: ReadonlyArray<string>, totals: typeof usage) => {
				events.push(...batch)
				usage = totals
				return mode !== "/abort"
			},
			submitDiagnosis: async () => {},
		}
		try {
			if (mode === "/hypothesis" || mode === "/solo")
				return Response.json(
					await this.env.AI_SERVICE.hypothesis(
						{
							...pass,
							deadlineAtMs: Date.now() + 60_000,
							scopeSummary: "Investigate",
							solo: mode === "/solo",
							rerun: false,
							hypothesis: {
								id: "pool",
								name: "Pool",
								question: "Is the pool exhausted?",
								claimToTest: "Pool capacity",
								rationale: "Queued requests",
								toolNames: [],
								priority: 1,
								seedLensId: null,
							},
						},
						tools,
						callbacks,
					),
				)
			if (mode === "/plan")
				return Response.json(
					await this.env.AI_SERVICE.plan(
						{ ...pass, deadlineAtMs: Date.now() + 60_000 },
						tools,
						callbacks,
					),
				)
			if (mode === "/validate")
				return Response.json(
					await this.env.AI_SERVICE.validate(
						{ ...pass, candidates: [], deadlineAtMs: Date.now() + 60_000 },
						tools,
						callbacks,
					),
				)
			await this.env.AI_SERVICE.chat(
				{
					sessionId: "org_test:default-test",
					messageId: "message-1",
					tenant: {
						orgId: mode === "/invalid" ? "" : "org_test",
						userId: "user_test",
						roles: [],
						authMode: "self_hosted",
					},
					tools,
					text: "Check services",
					history: [],
				},
				callbacks,
			)
			return Response.json({ events: events.map((event) => JSON.parse(event)), calls, usage })
		} catch {
			return Response.json({ failed: true, calls }, { status: 500 })
		}
	}
}
