import type { IngestRuleId } from "@maple/domain"
import { IngestRulePublicId } from "@maple/domain/http/v2"
import { Option, Schema } from "effect"
import { AppRoute, hrefOf } from "../../../route"
import type { TemplateId } from "./templates"

const encodePublicId = Schema.encodeSync(IngestRulePublicId)
const decodePublicId = Schema.decodeUnknownOption(IngestRulePublicId)

export const ruleIdFromUrl = (raw: string): Option.Option<IngestRuleId> => decodePublicId(raw)

export const ruleHref = (id: IngestRuleId): string =>
	hrefOf(AppRoute.IngestRule({ ruleId: encodePublicId(id) }))

export const newRuleHref = (template?: TemplateId): string =>
	hrefOf(AppRoute.IngestRuleNew({ search: template === undefined ? {} : { template } }))

export const ingestionHref = (): string => hrefOf(AppRoute.Settings({ search: { tab: "ingestion" } }))
