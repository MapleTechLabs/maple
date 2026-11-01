import ClerkKit
import SwiftUI

/// Chooses the organization whose data the app will show.
///
/// This is not optional chrome. The v2 API has no org header and rejects a
/// token with no active-organization claim, so the app is unusable until one is
/// selected.
///
/// It serves two roles: the gate shown when no organization is active, and the
/// sheet behind the toolbar switcher. Without the second, a user with more than
/// one organization would be stuck on whichever one Clerk happened to activate —
/// the gate is unreachable once an org exists.
struct OrganizationPickerView: View {
	/// `gate` is the full-screen, no-way-out variant; `switcher` is the sheet.
	enum Mode {
		case gate
		case switcher
	}

	var mode: Mode = .gate

	@Environment(SessionController.self) private var session
	@Environment(\.dismiss) private var dismiss
	@State private var isSwitching = false

	var body: some View {
		NavigationStack {
			ZStack {
				Token.background.ignoresSafeArea()

				if session.memberships.isEmpty {
					if session.membershipsLoaded {
						noMemberships
					} else {
						// Still fetching. Showing the "no organizations" dead end
						// here would be both wrong and alarming.
						SkeletonList(rowHeight: 56, rows: 3)
					}
				} else {
					picker
				}
			}
			.navigationTitle(mode == .gate ? "Organization" : "Switch organization")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar { toolbar }
			.mapleScreen(Screen.organizationPicker)
		}
		.tint(Token.primary)
		.task {
			// The sheet can outlive a stale list; refetch on present.
			if mode == .switcher { await session.loadMemberships() }
		}
	}

	@ToolbarContentBuilder
	private var toolbar: some ToolbarContent {
		switch mode {
		case .gate:
			if !session.memberships.isEmpty {
				ToolbarItem(placement: .topBarTrailing) {
					Button { Task { await session.signOut() } } label: {
						Text("Sign out")
							.font(Typo.smallMedium)
							.foregroundStyle(Token.mutedForeground)
					}
				}
			}
		case .switcher:
			ToolbarItem(placement: .topBarTrailing) {
				Button { dismiss() } label: {
					Text("Done")
						.font(Typo.smallMedium)
						.foregroundStyle(Token.primary)
				}
			}
		}
	}

	private var picker: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 0) {
				if let error = session.organizationError {
					Text(error)
						.font(Typo.small)
						.foregroundStyle(Token.destructive)
						.padding(16)
				}

				ForEach(session.memberships, id: \.id) { membership in
					Button {
						isSwitching = true
						Task {
							await session.select(organizationId: membership.organization.id)
							isSwitching = false
							if mode == .switcher, session.organizationError == nil { dismiss() }
						}
					} label: {
						OrganizationRow(
							membership: membership,
							isActive: membership.organization.id == session.activeOrganizationId
						)
					}
					.buttonStyle(RowButtonStyle())
					.disabled(isSwitching)
					Hairline()
				}
			}
		}
		.scrollContentBackground(.hidden)
		.disabled(isSwitching)
		.opacity(isSwitching ? 0.5 : 1)
	}

	private var noMemberships: some View {
		VStack(spacing: 16) {
			EmptyStateView(
				title: "No organizations",
				message:
					"This account isn't a member of any Maple organization yet. Ask an admin to invite you, then sign in again."
			)
			Button { Task { await session.signOut() } } label: {
				Text("Sign out")
					.font(Typo.smallMedium)
					.foregroundStyle(Token.foreground)
					.padding(.horizontal, 14)
					.frame(height: 32)
					.background(Token.muted, in: .rect(cornerRadius: Token.Radius.md))
			}
			.buttonStyle(.plain)
		}
	}
}

private struct OrganizationRow: View {
	let membership: OrganizationMembership
	var isActive = false

	var body: some View {
		HStack(spacing: 10) {
			// Organizations get the same categorical colour treatment services
			// do, so the mark is meaningful rather than decorative.
			ServiceDot(serviceName: membership.organization.id, size: 10)

			VStack(alignment: .leading, spacing: 3) {
				Text(membership.organization.name)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				Text(membership.role.replacingOccurrences(of: "org:", with: "").capitalized)
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
			}

			Spacer()

			if isActive {
				Image(systemName: "checkmark")
					.font(.system(size: 12, weight: .semibold))
					.foregroundStyle(Token.primary)
			} else {
				Image(systemName: "chevron.right")
					.font(.system(size: 11, weight: .semibold))
					.foregroundStyle(Token.mutedForeground.opacity(0.6))
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 14)
		.contentShape(.rect)
	}
}

/// The organization pill at the top of every tab root: the context everything
/// on screen is scoped to. With a single organization it names it and does
/// nothing when tapped.
struct OrganizationSwitcherButton: View {
	@Environment(SessionController.self) private var session
	@State private var isPresented = false

	var body: some View {
		Button { isPresented = true } label: {
			HStack(spacing: 8) {
				Text(String((session.activeOrganizationName ?? "?").prefix(1)).uppercased())
					.font(Typo.microMedium)
					.foregroundStyle(Token.primaryForeground)
					.frame(width: 24, height: 24)
					.background(Token.primary, in: .rect(cornerRadius: Token.Radius.sm))
				Text(session.activeOrganizationName ?? "Organization")
					.font(Typo.body.weight(.regular))
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
					.truncationMode(.tail)
				if session.canSwitchOrganization {
					PixelIcon.chevronDown.image
						.resizable()
						.frame(width: 12, height: 12)
						.foregroundStyle(Token.mutedForeground)
				}
			}
			.padding(.leading, 6)
			.padding(.trailing, 12)
			.frame(height: 36)
			.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
			.overlay(RoundedRectangle(cornerRadius: Token.Radius.lg).stroke(Token.border, lineWidth: Token.hairline))
			.frame(maxWidth: 200, alignment: .leading)
		}
		.buttonStyle(.plain)
		.disabled(!session.canSwitchOrganization)
		.accessibilityLabel("Switch organization")
		.accessibilityValue(session.activeOrganizationName ?? "")
		.sheet(isPresented: $isPresented) {
			OrganizationPickerView(mode: .switcher)
				.environment(session)
		}
	}
}
