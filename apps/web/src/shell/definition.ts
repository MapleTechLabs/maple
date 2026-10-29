import { Block } from "foldkit"
import { Message, OutMessage } from "./message"
import { Model } from "./model"

// The app shell's Definition: its local facts, its asks to the root and its Model.

export const ShellDefinition = Block.makeDefinition("Shell", { Model, Message, OutMessage })

export const { makeStep, makeNoopStep, makeFieldsStep, makeCommandsStep, makeOutMessageStep } =
	ShellDefinition
