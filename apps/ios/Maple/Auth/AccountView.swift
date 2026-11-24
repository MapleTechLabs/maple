import ClerkKit
import SwiftUI

/// The signed-in user's own page: who they are, notifications, legal links,
/// sign out and account deletion. Opened from the avatar on every tab root.
struct AccountView: View {
	@Environment(SessionController.self) private var session
	@Environment(Clerk.self) private var clerk
	@Environment(\.dismiss) private var dismiss
	@State private var showsNotificationSettings = false
	@State private var showsDeleteConfirmation = false

	var body: some View {
		NavigationStack {
			ZStack {
				Token.background.ignoresSafeArea()
				ScrollView {
					VStack(alignment: .leading, spacing: 24) {
						profileCard
						section("Settings") {
							row("Notifications") { showsNotificationSettings = true }
						}
						section("About") {
							link("Privacy policy", AccountLinks.privacy)
							Hairline()
							link("Terms of service", AccountLinks.terms)
							Hairline()
							link("Support", AccountLinks.support)
						}
						section("Account") {
							row("Sign out") {
								Task {
									await session.signOut()
									dismiss()
								}
							}
							if session.canDeleteAccount {
								Hairline()
								row("Delete account", tint: Token.destructive) { showsDeleteConfirmation = true }
							}
						}
						Text(AccountLinks.versionLine)
							.font(Typo.tiny)
							.foregroundStyle(Token.mutedForeground)
							.padding(.horizontal, 16)
					}
					.padding(.vertical, 16)
				}
				.scrollContentBackground(.hidden)
			}
			.navigationTitle("Account")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .principal) {
					Text("Account").font(Typo.monoTitle).foregroundStyle(Token.foreground)
				}
				ToolbarItem(placement: .topBarTrailing) {
					Button("Done") { dismiss() }
						.font(Typo.smallMedium)
						.foregroundStyle(Token.foreground)
				}
			}
			.sheet(isPresented: $showsNotificationSettings) {
				NotificationSettingsView().environment(session)
			}
			.sheet(isPresented: $showsDeleteConfirmation) {
				DeleteAccountView { dismiss() }.environment(session)
			}
			.mapleScreen(Screen.account)
		}
		.tint(Token.primary)
	}

	private var profileCard: some View {
		HStack(spacing: 12) {
			AccountAvatar(initials: AccountLinks.initials(for: clerk.user), size: 40)
			VStack(alignment: .leading, spacing: 4) {
				Text(AccountLinks.displayName(for: clerk.user))
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				if let email = clerk.user?.primaryEmailAddress?.emailAddress {
					Text(email)
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
						.truncationMode(.middle)
				}
				if let org = session.activeOrganizationName {
					Text(org)
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}
			}
		}
		.padding(16)
		.frame(maxWidth: .infinity, alignment: .leading)
		.hairlineCard()
		.padding(.horizontal, 16)
	}

	private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionLabel(title).padding(.horizontal, 16)
			VStack(spacing: 0) { content() }
				.hairlineCard()
				.padding(.horizontal, 16)
		}
	}

	private func row(_ title: String, tint: Color = Token.foreground, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			HStack {
				Text(title).font(Typo.body).foregroundStyle(tint)
				Spacer()
				PixelIcon.chevronRight.image
					.resizable()
					.frame(width: 12, height: 12)
					.foregroundStyle(Token.mutedForeground)
			}
			.padding(.horizontal, 16)
			.frame(height: 48)
			.contentShape(.rect)
		}
		.buttonStyle(RowButtonStyle())
	}

	private func link(_ title: String, _ url: URL) -> some View {
		Link(destination: url) {
			HStack {
				Text(title).font(Typo.body).foregroundStyle(Token.foreground)
				Spacer()
				PixelIcon.externalLink.image
					.resizable()
					.frame(width: 12, height: 12)
					.foregroundStyle(Token.mutedForeground)
			}
			.padding(.horizontal, 16)
			.frame(height: 48)
			.contentShape(.rect)
		}
		.buttonStyle(RowButtonStyle())
	}
}

/// Typed confirmation, as on the web: deleting is permanent and there is no
/// undo, so the button stays off until the word is typed.
private struct DeleteAccountView: View {
	@Environment(SessionController.self) private var session
	@Environment(\.dismiss) private var dismiss
	let onDeleted: () -> Void

	@State private var confirmation = ""
	@State private var isDeleting = false
	@State private var error: String?

	private static let word = "DELETE"

	var body: some View {
		NavigationStack {
			ZStack {
				Token.background.ignoresSafeArea()
				VStack(alignment: .leading, spacing: 16) {
					Text(
						"This permanently deletes your Maple account and removes you from every organization you belong to. Organizations you own, and the telemetry in them, are not deleted: hand them over or delete them on the web first."
					)
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)

					Text("Type \(Self.word) to confirm.")
						.font(Typo.smallMedium)
						.foregroundStyle(Token.foreground)

					TextField("", text: $confirmation)
						.font(Typo.body)
						.textInputAutocapitalization(.characters)
						.autocorrectionDisabled()
						.padding(.horizontal, 12)
						.frame(height: 40)
						.overlay(
							RoundedRectangle(cornerRadius: Token.Radius.md).stroke(Token.input, lineWidth: Token.hairline)
						)
						.accessibilityLabel("Type \(Self.word) to confirm")

					if let error {
						Text(error)
							.font(Typo.small)
							.foregroundStyle(Token.destructive)
							.fixedSize(horizontal: false, vertical: true)
					}

					Button {
						Task { await delete() }
					} label: {
						Text(isDeleting ? "Deleting…" : "Delete account")
							.font(Typo.smallMedium)
							.foregroundStyle(Token.background)
							.frame(maxWidth: .infinity)
							.frame(height: 40)
							.background(Token.destructive, in: .rect(cornerRadius: Token.Radius.md))
					}
					.buttonStyle(.plain)
					.disabled(confirmation != Self.word || isDeleting)
					.opacity(confirmation != Self.word || isDeleting ? 0.5 : 1)

					Spacer()
				}
				.padding(16)
			}
			.navigationTitle("Delete account")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .principal) {
					Text("Delete account").font(Typo.monoTitle).foregroundStyle(Token.foreground)
				}
				ToolbarItem(placement: .topBarLeading) {
					Button("Cancel") { dismiss() }
						.font(Typo.smallMedium)
						.foregroundStyle(Token.foreground)
						.disabled(isDeleting)
				}
			}
		}
		.interactiveDismissDisabled(isDeleting)
		.presentationDetents([.medium, .large])
	}

	private func delete() async {
		isDeleting = true
		error = nil
		do {
			try await session.deleteAccount()
			dismiss()
			onDeleted()
		} catch {
			self.error = "Couldn't delete the account: \(error.localizedDescription)"
			isDeleting = false
		}
	}
}

/// The avatar button on every tab root that opens `AccountView`.
struct AccountButton: View {
	@Environment(SessionController.self) private var session
	@Environment(Clerk.self) private var clerk
	@State private var isPresented = false

	var body: some View {
		Button { isPresented = true } label: {
			AccountAvatar(initials: AccountLinks.initials(for: clerk.user), size: 32)
				.frame(width: 44, height: 44)
				.contentShape(.rect)
		}
		.buttonStyle(.plain)
		.accessibilityLabel("Account")
		.sheet(isPresented: $isPresented) {
			AccountView().environment(session).environment(clerk)
		}
	}
}

private struct AccountAvatar: View {
	let initials: String
	let size: CGFloat

	var body: some View {
		Group {
			if initials.isEmpty {
				PixelIcon.user.image
					.resizable()
					.frame(width: size * 0.5, height: size * 0.5)
			} else {
				Text(initials).font(size > 36 ? Typo.bodyMedium : Typo.microMedium)
			}
		}
			.foregroundStyle(Token.foreground)
			.frame(width: size, height: size)
			.background(Token.muted, in: .circle)
			.overlay(Circle().stroke(Token.border, lineWidth: Token.hairline))
	}
}

enum AccountLinks {
	static let privacy = URL(string: "https://maple.dev/privacy")!
	static let terms = URL(string: "https://maple.dev/terms")!
	static let support = URL(string: "https://maple.dev/contact")!

	static var versionLine: String {
		let info = Bundle.main.infoDictionary
		let version = info?["CFBundleShortVersionString"] as? String ?? "?"
		let build = info?["CFBundleVersion"] as? String ?? "?"
		return "Maple \(version) (\(build))"
	}

	static func displayName(for user: User?) -> String {
		guard let user else { return "Signed in" }
		let name = [user.firstName, user.lastName].compactMap { $0 }.joined(separator: " ")
		if !name.isEmpty { return name }
		return user.primaryEmailAddress?.emailAddress ?? "Signed in"
	}

	/// Empty when there is nothing to show; the avatar then draws a person glyph.
	static func initials(for user: User?) -> String {
		guard let user else { return "" }
		let letters = [user.firstName, user.lastName].compactMap { $0?.first }
		if !letters.isEmpty { return String(letters.prefix(2)).uppercased() }
		return user.primaryEmailAddress?.emailAddress.first.map { String($0).uppercased() } ?? ""
	}
}
