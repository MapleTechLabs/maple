import { PermissionRule, type PermissionRuleset } from "@maple/domain/permission"
import type { AiToolDescriptor } from "@maple/domain/ai-service"

export const defaultRuleset = (tools: ReadonlyArray<AiToolDescriptor>): PermissionRuleset => [
	new PermissionRule({ tool: "*", action: "allow" }),
	...tools
		.filter((tool) => tool.mutating)
		.map((tool) => tool.name)
		.sort()
		.map((tool) => new PermissionRule({ tool, action: "ask" })),
]
export const readOnlyRuleset = (tools: ReadonlyArray<AiToolDescriptor>): PermissionRuleset => [
	new PermissionRule({ tool: "*", action: "deny" }),
	...tools
		.filter((tool) => !tool.mutating)
		.map((tool) => tool.name)
		.sort()
		.map((tool) => new PermissionRule({ tool, action: "allow" })),
]
