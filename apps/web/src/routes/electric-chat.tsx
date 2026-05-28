import { createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { ElectricChatPage } from "@/components/electric-chat/electric-chat-page"

const ElectricChatSearch = Schema.Struct({
	conversation: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/electric-chat"))({
	component: ElectricChatRoute,
	validateSearch: Schema.toStandardSchemaV1(ElectricChatSearch),
})

function ElectricChatRoute() {
	const { conversation } = Route.useSearch()
	return <ElectricChatPage urlConversationId={conversation} />
}
