import MapleAPI
import SwiftUI

/// The severity bands the histogram stacks: error-and-above, warn, and the rest.
enum LogsVolumeBand: CaseIterable {
	case other
	case warn
	case error

	/// Groups an OTel severity text (`ERROR`, `FATAL`, `WARNING`, ...) into a band.
	init(severity: String) {
		let text = severity.uppercased()
		if ["ERR", "FATAL", "CRIT", "ALERT", "EMERG", "PANIC"].contains(where: text.hasPrefix) {
			self = .error
		} else if text.hasPrefix("WARN") {
			self = .warn
		} else {
			self = .other
		}
	}

	var tint: Color {
		switch self {
		case .error: Token.severityError
		case .warn: Token.severityWarn
		case .other: Token.mutedForeground.opacity(0.45)
		}
	}
}

/// Per-bucket counts per band, folded from the severity-grouped series.
struct LogsVolumeBands: Sendable {
	/// `buckets[i][band]`, bottom of the stack first.
	let buckets: [[LogsVolumeBand: Double]]

	init(_ volume: LogVolume) {
		let width = volume.series.map(\.values.count).max() ?? 0
		var buckets = Array(repeating: [LogsVolumeBand: Double](), count: width)
		for series in volume.series {
			let band = LogsVolumeBand(severity: series.severity)
			for (index, value) in series.values.enumerated() {
				buckets[index][band, default: 0] += value
			}
		}
		self.buckets = buckets
	}

	func total(_ band: LogsVolumeBand) -> Double {
		buckets.reduce(0) { $0 + ($1[band] ?? 0) }
	}

	var total: Double { buckets.reduce(0) { $0 + $1.values.reduce(0, +) } }
	var isEmpty: Bool { total == 0 }
}

/// `VOLUME   ■ error 138  ■ warn 274` over stacked severity bars.
struct LogsVolumeHistogram: View {
	let bands: LogsVolumeBands

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionHeader(title: "Volume") {
				HStack(spacing: 12) {
					legend(.error, "error")
					legend(.warn, "warn")
				}
			}
			bars
				.frame(height: 52)
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(
			"Log volume: \(Format.count(bands.total(.error))) errors, \(Format.count(bands.total(.warn))) warnings"
		)
	}

	private func legend(_ band: LogsVolumeBand, _ label: String) -> some View {
		HStack(spacing: 4) {
			RoundedRectangle(cornerRadius: 2)
				.fill(band.tint)
				.frame(width: 8, height: 8)
			Text("\(label) \(Format.count(bands.total(band)))")
				.font(Typo.micro)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
		}
	}

	private var bars: some View {
		GeometryReader { proxy in
			let peak = max(bands.buckets.map { $0.values.reduce(0, +) }.max() ?? 1, 1)
			let scale = proxy.size.height / peak
			HStack(alignment: .bottom, spacing: 3) {
				ForEach(Array(bands.buckets.enumerated()), id: \.offset) { _, bucket in
					VStack(spacing: 0) {
						ForEach([LogsVolumeBand.error, .warn, .other], id: \.self) { band in
							let value = bucket[band] ?? 0
							if value > 0 {
								Rectangle()
									.fill(band.tint)
									.frame(height: max(value * scale, 1))
							}
						}
					}
					.frame(maxWidth: .infinity)
				}
			}
			.frame(maxHeight: .infinity, alignment: .bottom)
			.overlay(alignment: .bottom) { Hairline() }
		}
	}
}
