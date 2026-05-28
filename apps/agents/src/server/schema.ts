import { z } from "zod"

export const messageSchema = z.object({
	key: z.string().min(1),
	role: z.enum(["user", "agent"]),
	sender: z.string().min(1),
	senderName: z.string().min(1),
	text: z.string().min(1),
	timestamp: z.number(),
	// Tools the agent called this turn (assistant agent only) — name, args, and output,
	// so the client can render full tool cards.
	tools: z
		.array(
			z.object({
				name: z.string(),
				toolCallId: z.string().optional(),
				status: z.string(),
				args: z.unknown().optional(),
				result: z.unknown().optional(),
				error: z.string().optional(),
			}),
		)
		.optional(),
})

export type Message = z.infer<typeof messageSchema>

/** Shared chatroom state: a single `messages` collection observed by every agent. */
export const chatroomSchema = {
	messages: {
		schema: messageSchema,
		type: "shared:message",
		primaryKey: "key",
	},
} as const
