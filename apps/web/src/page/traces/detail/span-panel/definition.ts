import { Block } from "foldkit"
import { Message, OutMessage } from "./message"
import { Model } from "./model"

// The span panel's Definition: it asks the page to close it, select another span, or navigate.

export const SpanPanelDefinition = Block.makeDefinition("SpanPanel", { Model, Message, OutMessage })

export const { makeStep, makeNoopStep } = SpanPanelDefinition
