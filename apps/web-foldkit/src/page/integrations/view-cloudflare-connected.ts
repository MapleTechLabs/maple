import type { CloudflareIntegrationStatus } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./message"
import type { Model } from "./model"

// The connected `CloudflareAccountCard`: accounts, ingest phase, stat band, zone board, Workers.

export const cloudflareConnected = (
	h: HtmlBuilder<Message>,
	_model: Model,
	_status: CloudflareIntegrationStatus,
	_timeZone: string,
): Html => h.empty
