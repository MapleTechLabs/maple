import { Maple } from "@maple-dev/effect-sdk/client"
import { ingestUrl } from "./ingest-url"

export const mapleOtelLayer = Maple.layer({
	serviceName: "maple-web",
	serviceNamespace: "client",
	endpoint: ingestUrl,
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY,
	environment: import.meta.env.MODE,
	serviceVersion: import.meta.env.VITE_COMMIT_SHA,
	attributes: {
		"vcs.repository.url.full": "https://github.com/Makisuo/maple",
		...(import.meta.env.VITE_COMMIT_SHA ? { "vcs.ref.head.revision": import.meta.env.VITE_COMMIT_SHA } : {}),
	},
})
