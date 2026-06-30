import { WeeklyDigest } from "../weekly-digest"
import { baseDigestProps } from "./_sample"

/** react-email preview entry — "watch" week (elevated error rate / errors climbing). */
export default function WeeklyDigestWatchPreview() {
	return WeeklyDigest({
		...baseDigestProps,
		summary: {
			...baseDigestProps.summary,
			requests: { value: 980_000, delta: -4.1 },
			errors: { value: 21_400, delta: 38.6 },
			p95Latency: { valueMs: 410, delta: 28.9 },
		},
		series: baseDigestProps.series.map((d, i) => ({
			...d,
			errors: Math.round(d.requests * (0.012 + i * 0.004)),
		})),
		services: [
			{ name: "payments", requests: 120_000, errorRate: 3.4, p95Ms: 520, requestsDelta: -2.1 },
			{ name: "api-gateway", requests: 410_000, errorRate: 1.8, p95Ms: 180, requestsDelta: -6.4 },
			{ name: "auth-service", requests: 240_000, errorRate: 1.1, p95Ms: 130, requestsDelta: 3.2 },
			{ name: "user-service", requests: 78_000, errorRate: 0.5, p95Ms: 96, requestsDelta: 0.4 },
		],
	})
}
