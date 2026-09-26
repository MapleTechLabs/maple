/**
 * Migration 0033: `ai_crawler_requests`, the crawler half of the Web Analytics AI tab.
 *
 * AI crawlers fetch pages without running JavaScript, so the browser SDK never
 * sees them; only Server spans do, and reading their user agent off raw `traces`
 * times out past about two days. This is a filtered projection (the
 * `ai_trace_index` shape): Server spans whose user agent names an AI crawler.
 *
 * Nothing is backfilled; the view fills forward from creation.
 * `requiredForIngest: false`: nothing writes the table directly.
 *
 * The CREATE statements are the verbatim DDL the schema emitter produced at v33.
 * Frozen history: never re-derive it from a later snapshot.
 */
export const migration_0033_ai_crawler_requests = {
	version: 33,
	description:
		"Create ai_crawler_requests + ai_crawler_requests_mv: Server spans from AI crawlers for the Web Analytics AI tab",
	requiredForIngest: false,
	statements: [
		"CREATE TABLE IF NOT EXISTS ai_crawler_requests (\n    OrgId LowCardinality(String),\n    Timestamp DateTime64(9),\n    TraceId String,\n    ServiceName LowCardinality(String),\n    Crawler LowCardinality(String),\n    Host LowCardinality(String),\n    Path String,\n    HttpStatus UInt16\n)\nENGINE = MergeTree\nPARTITION BY toDate(Timestamp)\nORDER BY (OrgId, Timestamp, TraceId)\nTTL toDate(Timestamp) + INTERVAL 30 DAY",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS ai_crawler_requests_mv TO ai_crawler_requests AS\nSELECT\n          OrgId,\n          Timestamp,\n          TraceId,\n          ServiceName,\n          arrayElement(['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Meta-ExternalAgent', 'Meta-WebIndexer', 'Meta-ExternalFetcher', 'Bytespider', 'MistralAI-User', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'cohere-training-data-crawler', 'cohere-ai'], multiSearchFirstIndexCaseInsensitive(coalesce(nullIf(SpanAttributes['user_agent.original'], ''), nullIf(SpanAttributes['http.user_agent'], ''), ''), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'meta-externalagent', 'meta-webindexer', 'meta-externalfetcher', 'Bytespider', 'MistralAI-User', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'cohere-training-data-crawler', 'cohere-ai'])) AS Crawler,\n          lower(replaceRegexpOne(coalesce(nullIf(SpanAttributes['server.address'], ''), nullIf(SpanAttributes['http.host'], ''), nullIf(SpanAttributes['net.host.name'], ''), nullIf(domain(SpanAttributes['url.full']), ''), nullIf(domain(SpanAttributes['http.url']), ''), ''), ':[0-9]+$', '')) AS Host,\n          leftUTF8(coalesce(nullIf(SpanAttributes['url.path'], ''), nullIf(replaceRegexpOne(SpanAttributes['http.target'], '[?#].*$', ''), ''), nullIf(path(SpanAttributes['url.full']), ''), nullIf(path(SpanAttributes['http.url']), ''), ''), 512) AS Path,\n          toUInt16OrZero(coalesce(nullIf(SpanAttributes['http.response.status_code'], ''), nullIf(SpanAttributes['http.status_code'], ''), '')) AS HttpStatus\n        FROM traces\n        WHERE SpanKind = 'Server'\n          AND multiSearchFirstIndexCaseInsensitive(coalesce(nullIf(SpanAttributes['user_agent.original'], ''), nullIf(SpanAttributes['http.user_agent'], ''), ''), ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'meta-externalagent', 'meta-webindexer', 'meta-externalfetcher', 'Bytespider', 'MistralAI-User', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'cohere-training-data-crawler', 'cohere-ai']) > 0\n          AND leftUTF8(coalesce(nullIf(SpanAttributes['url.path'], ''), nullIf(replaceRegexpOne(SpanAttributes['http.target'], '[?#].*$', ''), ''), nullIf(path(SpanAttributes['url.full']), ''), nullIf(path(SpanAttributes['http.url']), ''), ''), 512) != ''",
	],
} as const
