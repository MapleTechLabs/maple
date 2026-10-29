import { Block } from "foldkit"
import { PageOutMessage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

// The host detail page's Definition: its asks to the root are the shared PageOutMessage.

export const HostDetailDefinition = Block.makeDefinition("InfraHost", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})

export const { makeStep, makeNoopStep } = HostDetailDefinition
