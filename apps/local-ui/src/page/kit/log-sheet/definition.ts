import { Block } from "foldkit"
import { Message } from "./message"
import { ChildInitContext, Model } from "./model"

// The log detail sheet's Definition. It has no OutMessage: its parents read `isOpen` and `log`.

export const LogSheetDefinition = Block.makeDefinition("LogSheet", { Model, Message, ChildInitContext })

export const { makeStep, makeNoopStep, makeFieldsStep } = LogSheetDefinition
