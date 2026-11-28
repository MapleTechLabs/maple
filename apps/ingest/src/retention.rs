//! How long each signal is kept, per organization and per source. Mirrors
//! `packages/domain/src/retention.ts`; `packages/domain/fixtures/retention-stamp.json`
//! holds both to the same answers.

use serde_json::Value;

pub const MIN_RETENTION_DAYS: u16 = 1;
/// The longest any signal can be kept: the top of the storage ladder.
pub const MAX_RETENTION_DAYS: u16 = 730;

/// The periods rows are stored under: the periods a policy can hold. A stored value off
/// the ladder is stamped with the next period up.
pub const STAMP_LADDER: [u16; 9] = [3, 7, 14, 30, 60, 90, 180, 365, 730];

/// A signal with a retention period: the families a source can be limited to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RetentionSignal {
    Traces,
    Logs,
    Metrics,
    Sessions,
    Events,
    Profiles,
}

impl RetentionSignal {
    pub const ALL: [Self; 6] = [
        Self::Traces,
        Self::Logs,
        Self::Metrics,
        Self::Sessions,
        Self::Events,
        Self::Profiles,
    ];

    /// The key the policy jsonb stores this signal under.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Traces => "traces",
            Self::Logs => "logs",
            Self::Metrics => "metrics",
            Self::Sessions => "sessions",
            Self::Events => "events",
            Self::Profiles => "profiles",
        }
    }

    /// What an organization keeps when it has set nothing: the raw tables' own periods.
    pub const fn default_days(self) -> u16 {
        match self {
            Self::Traces | Self::Logs | Self::Sessions => 30,
            Self::Metrics => 90,
            Self::Events => 365,
            Self::Profiles => 14,
        }
    }

    /// What a row of this signal is stored under when no policy was resolved for it.
    pub fn default_stamp(self) -> u16 {
        stamp_for_days(self.default_days())
    }

    const fn index(self) -> usize {
        self as usize
    }
}

/// Days per signal one organization or one source set. A signal left out inherits: a
/// source from its organization, an organization from the defaults.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RetentionOverrides([Option<u16>; 6]);

impl RetentionOverrides {
    /// A `retention_days` jsonb column read as text. Never fails: a value that is not
    /// a whole number of days in range is ignored for its signal, which then inherits.
    pub fn parse(raw: Option<&str>) -> Self {
        let Some(Ok(Value::Object(stored))) = raw.map(serde_json::from_str::<Value>) else {
            return Self::default();
        };
        let mut overrides = Self::default();
        for signal in RetentionSignal::ALL {
            overrides.0[signal.index()] = stored.get(signal.as_str()).and_then(valid_days);
        }
        overrides
    }

    pub const fn get(&self, signal: RetentionSignal) -> Option<u16> {
        self.0[signal.index()]
    }

    #[must_use]
    pub const fn with(mut self, signal: RetentionSignal, days: u16) -> Self {
        self.0[signal.index()] = Some(days);
        self
    }
}

/// A stored value as days, when it is a whole number in range.
fn valid_days(value: &Value) -> Option<u16> {
    let days = value.as_f64()?;
    let range = f64::from(MIN_RETENTION_DAYS)..=f64::from(MAX_RETENTION_DAYS);
    if days.fract() != 0.0 || !range.contains(&days) {
        return None;
    }
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a whole number already checked to lie in 1..=730"
    )]
    let days = days as u16;
    Some(days)
}

/// The period a row is stored under for a policy of `days`: the shortest ladder
/// period that covers it.
pub fn stamp_for_days(days: u16) -> u16 {
    STAMP_LADDER
        .into_iter()
        .find(|period| *period >= days)
        .unwrap_or(MAX_RETENTION_DAYS)
}

/// What one source's rows of `signal` are stamped with: its own override, else the
/// organization's, else the default, on the storage ladder.
pub fn stamp_days(
    organization: &RetentionOverrides,
    source: &RetentionOverrides,
    signal: RetentionSignal,
) -> u16 {
    let days = source
        .get(signal)
        .or_else(|| organization.get(signal))
        .unwrap_or_else(|| signal.default_days());
    stamp_for_days(days)
}

/// One source's stamp for every signal, worked out once when its policy is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetentionStamps([u16; 6]);

impl RetentionStamps {
    pub fn resolve(organization: &RetentionOverrides, source: &RetentionOverrides) -> Self {
        Self(RetentionSignal::ALL.map(|signal| stamp_days(organization, source, signal)))
    }

    pub const fn get(&self, signal: RetentionSignal) -> u16 {
        self.0[signal.index()]
    }
}

/// Nothing set anywhere: every signal at its default.
impl Default for RetentionStamps {
    fn default() -> Self {
        let none = RetentionOverrides::default();
        Self::resolve(&none, &none)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::collections::BTreeMap;

    /// Shared with `packages/domain/src/retention-stamp.fixtures.test.ts`.
    const FIXTURES: &str = include_str!("../../../packages/domain/fixtures/retention-stamp.json");

    #[derive(Deserialize)]
    struct Fixtures {
        cases: Vec<Case>,
        #[serde(rename = "invalidStored")]
        invalid_stored: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        organization: Value,
        source: Value,
        expected: BTreeMap<String, u16>,
    }

    /// Each side goes through the text the gateway reads the jsonb column as.
    fn resolved(case: &Case) -> BTreeMap<String, u16> {
        let organization = RetentionOverrides::parse(Some(&case.organization.to_string()));
        let source = RetentionOverrides::parse(Some(&case.source.to_string()));
        let stamps = RetentionStamps::resolve(&organization, &source);
        RetentionSignal::ALL
            .into_iter()
            .map(|signal| {
                assert_eq!(
                    stamps.get(signal),
                    stamp_days(&organization, &source, signal),
                    "{}: {}",
                    case.name,
                    signal.as_str()
                );
                (signal.as_str().to_owned(), stamps.get(signal))
            })
            .collect()
    }

    fn fixtures() -> Fixtures {
        serde_json::from_str(FIXTURES).expect("the retention fixture parses")
    }

    #[test]
    fn stamps_match_the_shared_fixture() {
        let fixtures = fixtures();
        assert!(!fixtures.cases.is_empty(), "no fixture cases");
        for case in &fixtures.cases {
            assert_eq!(resolved(case), case.expected, "{}", case.name);
        }
    }

    #[test]
    fn stored_values_the_api_cannot_write_are_ignored() {
        let fixtures = fixtures();
        assert!(!fixtures.invalid_stored.is_empty(), "no fixture cases");
        for case in &fixtures.invalid_stored {
            assert_eq!(resolved(case), case.expected, "{}", case.name);
        }
    }

    #[test]
    fn a_missing_or_unreadable_column_sets_nothing() {
        let none = RetentionOverrides::default();
        assert_eq!(RetentionOverrides::parse(None), none);
        assert_eq!(RetentionOverrides::parse(Some("")), none);
        assert_eq!(RetentionOverrides::parse(Some("{\"traces\": 45")), none);
        assert_eq!(RetentionStamps::resolve(&none, &none), RetentionStamps::default());
    }

    #[test]
    fn a_key_that_is_no_signal_changes_nothing() {
        let stored = RetentionOverrides::parse(Some(r#"{"traces": 45, "spans": 3}"#));
        assert_eq!(
            stored,
            RetentionOverrides::default().with(RetentionSignal::Traces, 45)
        );
    }

    #[test]
    fn every_stamp_is_a_ladder_period_that_covers_its_policy() {
        for days in MIN_RETENTION_DAYS..=MAX_RETENTION_DAYS {
            let stamp = stamp_for_days(days);
            assert!(STAMP_LADDER.contains(&stamp), "{days} days stamped {stamp}");
            assert!(stamp >= days, "{days} days stamped {stamp}");
            let shorter = STAMP_LADDER.into_iter().filter(|period| *period < stamp);
            assert!(shorter.max().is_none_or(|period| period < days), "{days}");
        }
    }
}
