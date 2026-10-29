import { Block } from "foldkit"
import { Message, Model } from "./model"

// The infra correlation panel's Definition: it reads and draws, and asks nothing of its parent.

export const InfraCorrelationDefinition = Block.makeDefinition("InfraCorrelation", { Model, Message })

export const { makeStep } = InfraCorrelationDefinition
