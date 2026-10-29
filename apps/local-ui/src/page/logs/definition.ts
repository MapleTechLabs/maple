import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

// The Logs page's Definition: its asks to the root are the shared PageOutMessage.

export const LogsDefinition = Block.makeDefinition("Logs", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})

export const { makeStep, makeNoopStep } = LogsDefinition
