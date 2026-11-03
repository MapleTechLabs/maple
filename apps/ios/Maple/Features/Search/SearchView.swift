import MapleAPI
import SwiftUI

/// What the Search tab matches against: the last day's services and the most
/// recent issues, fetched once per scope and filtered on the phone.
struct SearchIndex: Sendable {
	let services: [Service]
	let issues: [ErrorIssue]
}

@MainActor
@Observable
final class SearchModel {
	private(set) var loader: ScreenLoader<SearchIndex>!
	let scope: SessionController.DataScope
	/// The issues API has no text query, so one page is fetched and matched locally.
	static let issueLimit = 50
	private let api: any MapleAPI

	init(api: any MapleAPI, session: SessionController, scope: SessionController.DataScope) {
		self.api = api
		self.scope = scope
		loader = ScreenLoader(
			session: session,
			screen: Screen.search,
			isEmpty: { $0.services.isEmpty && $0.issues.isEmpty }
		) { [unowned self] in
			async let services = self.api.services(window: TimeWindow.last24Hours.resolve(), limit: 100)
			async let issues = self.api.issues(query: IssueQuery(), window: nil, limit: Self.issueLimit, cursor: nil)
			return SearchIndex(
				services: try await services.items.sorted { $0.name < $1.name },
				issues: try await issues.items
			)
		}
	}
}

/// Search across services, issues and trace ids. A 32-hex query jumps straight
/// to that trace; anything else filters services and issues by name.
struct SearchView: View {
	@Environment(SessionController.self) private var session
	@Environment(EnvironmentController.self) private var environments
	@State private var model: SearchModel?
	@State private var query = ""
	@State private var path: [Route] = []

	private var scope: SessionController.DataScope {
		.init(generation: session.dataGeneration, environment: environments.selected)
	}

	var body: some View {
		NavigationStack(path: $path) {
			ZStack {
				Token.background.ignoresSafeArea()
				LoadableView(
					loader: model?.loader,
					emptyTitle: "Nothing to search yet",
					emptyMessage: "No services or issues reported in the last 24 hours.",
					skeletonRowHeight: 52,
					header: { TabRootHeader(title: "Search") }
				) { index in
					SearchResults(index: index, query: query)
				}
			}
			.tabRootChrome()
			.mapleDestinations()
			.mapleScreen(Screen.search)
		}
		.searchable(text: $query, prompt: "Services, issues or a trace id")
		.autocorrectionDisabled()
		.textInputAutocapitalization(.never)
		.task(id: scope) {
			let model = model?.scope == scope
				? model!
				: SearchModel(api: session.api.scoped(toEnvironment: scope.environment), session: session, scope: scope)
			self.model = model
			await model.loader.loadIfNeeded()
		}
	}
}

private struct SearchResults: View {
	let index: SearchIndex
	let query: String

	/// With no query the tab is a browse list, so it stays short.
	private static let browseLimit = 8

	private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

	/// A W3C trace id: exactly 32 hex characters.
	private var traceID: String? {
		let text = trimmed.lowercased()
		guard text.count == 32, text.allSatisfy(\.isHexDigit) else { return nil }
		return text
	}

	private var services: [Service] {
		guard !trimmed.isEmpty else { return Array(index.services.prefix(Self.browseLimit)) }
		return index.services.filter { $0.name.localizedCaseInsensitiveContains(trimmed) }
	}

	private var issues: [ErrorIssue] {
		guard !trimmed.isEmpty else { return Array(index.issues.prefix(Self.browseLimit)) }
		return index.issues.filter { issue in
			[issue.exceptionType, issue.exceptionMessage, issue.serviceName, issue.errorLabel]
				.contains { $0.localizedCaseInsensitiveContains(trimmed) }
		}
	}

	var body: some View {
		let services = services
		let issues = issues
		VStack(alignment: .leading, spacing: 20) {
			if let traceID {
				section("Trace") {
					NavigationLink(value: Route.trace(id: traceID)) {
						SearchRow(title: "Open trace", detail: traceID, mono: true)
					}
					.buttonStyle(RowButtonStyle())
				}
			}

			if !services.isEmpty {
				section(trimmed.isEmpty ? "Services" : "Services · \(services.count)") {
					ForEach(Array(services.enumerated()), id: \.element.name) { offset, service in
						NavigationLink(value: Route.service(name: service.name)) {
							SearchRow(
								title: service.name,
								detail: "\(Format.rps(service.throughput)) · p95 \(Format.latency(service.p95LatencyMs))",
								serviceName: service.name
							)
						}
						.buttonStyle(RowButtonStyle())
						if offset < services.count - 1 { Hairline() }
					}
				}
			}

			if !issues.isEmpty {
				section(trimmed.isEmpty ? "Recent issues" : "Issues · \(issues.count)") {
					ForEach(Array(issues.enumerated()), id: \.element.id) { offset, issue in
						NavigationLink(value: Route.issue(id: issue.id)) {
							SearchRow(
								title: issue.exceptionType,
								detail: "\(issue.serviceName) · \(Format.ago(issue.lastSeenAt))",
								serviceName: issue.serviceName
							)
						}
						.buttonStyle(RowButtonStyle())
						if offset < issues.count - 1 { Hairline() }
					}
				}
			}

			if !trimmed.isEmpty, traceID == nil {
				if services.isEmpty, issues.isEmpty {
					Text("No services or issues match \u{201C}\(trimmed)\u{201D}.")
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
						.frame(maxWidth: .infinity)
						.padding(.top, 24)
				}
				Text("Issues are matched against the \(SearchModel.issueLimit) most recent.")
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.frame(maxWidth: .infinity)
			}
		}
		.padding(.horizontal, 16)
		.padding(.top, 20)
		.padding(.bottom, 24)
	}

	private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
		TitledSection(SectionHeader(title: title)) {
			VStack(spacing: 0) { content() }
				.hairlineCard()
		}
	}
}

/// One result: optional service swatch, a title and a muted detail line.
private struct SearchRow: View {
	let title: String
	let detail: String
	var serviceName: String? = nil
	var mono = false

	var body: some View {
		HStack(spacing: 10) {
			if let serviceName { ServiceDot(serviceName: serviceName) }
			VStack(alignment: .leading, spacing: 3) {
				Text(title)
					.font(Typo.smallMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				Text(detail)
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
					.truncationMode(mono ? .middle : .tail)
			}
			Spacer(minLength: 8)
			PixelIcon.chevronRight.image
				.resizable()
				.frame(width: 12, height: 12)
				.foregroundStyle(Token.mutedForeground)
				.accessibilityHidden(true)
		}
		.padding(.horizontal, 12)
		.frame(minHeight: 52)
		.contentShape(.rect)
		.accessibilityElement(children: .combine)
	}
}
