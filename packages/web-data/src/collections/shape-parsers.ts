/**
 * Every timestamptz column arrives from Electric as a raw Postgres string; this
 * parser normalizes it to ISO so the row-schema String fields decode straight to
 * the domain Document's branded `IsoDateTimeString`. Shared by every
 * timestamptz-bearing shape (alerts, errors).
 */
export const timestamptzParser = { timestamptz: (v: string) => new Date(v).toISOString() }
