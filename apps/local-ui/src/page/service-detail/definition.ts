import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

// The service detail page's Definition: its asks to the root are the shared PageOutMessage.

export const ServiceDetailDefinition = Block.makeDefinition("ServiceDetail", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})
