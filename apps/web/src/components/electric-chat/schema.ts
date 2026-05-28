import { z } from "zod"

// Browser-side mirror of the shared chatroom schema defined in apps/agents. Must
// match so the durable-stream client materializes rows the same way.
export const messageSchema = z.object({
	key: z.string().min(1),
	role: z.enum(["user", "agent"]),
	sender: z.string().min(1),
	senderName: z.string().min(1),
	text: z.string().min(1),
	timestamp: z.number(),
	tools: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
})

export type ChatMessage = z.infer<typeof messageSchema>

export const chatroomSchema = {
	messages: {
		schema: messageSchema,
		type: "shared:message",
		primaryKey: "key",
	},
} as const
