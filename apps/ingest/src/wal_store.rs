//! The WAL's durability tier: sealed segments shipped to S3, and the claiming
//! protocol that lets a booting task recover a dead one's.
//!
//! The local WAL lives on Fargate ephemeral storage, which is destroyed with the
//! task. A drain on SIGTERM covers a graceful stop; this covers everything else
//! — a crash, a spot reclaim, an AZ event — by keeping every sealed, unexported
//! segment in an object store too.
//!
//! Cost is small because segments are transient: a segment is deleted from the
//! bucket as soon as its frames export, so the bucket holds roughly the current
//! backlog rather than the traffic. At ~8 MiB per object and a healthy pipeline,
//! most segments are exported before their upload is even attempted.
//!
//! Ownership is per boot, not per task ARN: an owner id is a fresh UUID, so a
//! sequence number is never reused across boots and a claim can never race a
//! live writer for the same key.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use tracing::warn;

use crate::aws::{CredentialsProvider, PutCondition, S3Client, S3Error, S3Object};
use crate::telemetry::HttpClient;

/// Object-key scheme version. A future layout change lands under `v2/` while
/// `v1/` keys stay decodable for as long as a task could still be holding them.
const KEY_SCHEME: &str = "v1";

/// Pages of a listing we will walk. A boot lists its own prefix and each dead
/// owner's; 1000 keys a page makes this 100k segments, far past any real
/// backlog, and bounds a pathological prefix instead of hanging startup.
const MAX_LIST_PAGES: usize = 100;

/// How stale an owner's heartbeat must be before its segments are claimable.
///
/// Well past the heartbeat interval: claiming a live task's segments is not
/// unsafe (the frames replay at-least-once, which every destination tolerates)
/// but it is wasted work and duplicated rows, so the bar is deliberately high.
pub const DEFAULT_ORPHAN_AFTER: Duration = Duration::from_secs(10 * 60);

/// How often a live task refreshes its heartbeat object.
pub const DEFAULT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);

/// How long a claim marker holds an owner before another task may take it over.
///
/// A claimer that dies mid-recovery would otherwise strand those segments
/// forever. Taking over an expired claim can replay frames the first claimer had
/// already exported — at-least-once again, and the alternative is loss.
const CLAIM_LEASE: Duration = Duration::from_secs(30 * 60);

/// How often a claim under recovery is re-stamped. Well inside `CLAIM_LEASE`, so
/// several renewals can fail before a live recovery looks abandoned.
const CLAIM_RENEW_EVERY: Duration = Duration::from_secs(5 * 60);

/// How long `retire` waits for an in-flight heartbeat before deleting the owner
/// key. Short, so a stalled heartbeat cannot eat the shutdown budget; the retired
/// marker is already written by then and alone makes the owner claimable.
const RETIRE_HEARTBEAT_WAIT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug)]
pub struct WalStoreConfig {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    /// Key prefix inside the bucket, without a trailing slash.
    pub prefix: String,
    pub timeout: Duration,
    pub orphan_after: Duration,
    pub heartbeat_interval: Duration,
}

/// This task's hold on one dead owner, fenced by the ETag of its last write to
/// the claim object.
///
/// Every renewal is an `If-Match` PUT on that ETag. A task whose claim expired
/// and was taken over learns so on its next renewal (412) instead of
/// overwriting the successor's claim, and from then on stops recovering and
/// leaves the owner's markers alone.
#[derive(Debug)]
pub struct OwnerClaim {
    owner: String,
    etag: std::sync::Mutex<String>,
    lost: AtomicBool,
}

impl OwnerClaim {
    pub fn owner(&self) -> &str {
        &self.owner
    }

    /// A renewal found another task holding the claim. Recovery stops at the
    /// next segment and the owner is left for the holder to clean up.
    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::Acquire)
    }

    fn etag(&self) -> String {
        self.etag
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn set_etag(&self, etag: String) {
        *self
            .etag
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = etag;
    }

    fn mark_lost(&self) {
        self.lost.store(true, Ordering::Release);
    }
}

/// What `release_owner` did with a claimed owner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimRelease {
    /// Markers and claim deleted: the owner is gone.
    Released,
    /// Another task holds the claim now; nothing was deleted.
    Lost,
    /// Segments appeared under the owner since recovery listed it; the markers
    /// stay so a later boot finds them.
    SegmentsRemain,
}

/// A segment a dead owner left in the object store. Recovery fetches its bytes
/// one segment at a time, and deletes the key once its frames are durable
/// locally again.
#[derive(Debug)]
pub struct OrphanedSegment {
    pub key: String,
    /// `shard-NNN-<destination>`, as written by the task that owned it.
    pub lane_key: String,
}

pub struct WalSegmentStore {
    s3: S3Client,
    prefix: String,
    /// This boot's identity. Fresh per process, so no other task can be writing
    /// under it and its segments are unambiguously ours to delete.
    owner: String,
    orphan_after: Duration,
    /// Set first thing in `retire`; a heartbeat checks it under `heartbeat_lock`
    /// before its PUT, so none starts once retire has begun.
    retired: AtomicBool,
    /// Held across a heartbeat PUT. `retire` takes it before deleting the owner
    /// key, so an in-flight heartbeat cannot land after the delete.
    heartbeat_lock: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for WalSegmentStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WalSegmentStore")
            .field("bucket", &self.s3.bucket())
            .field("prefix", &self.prefix)
            .field("owner", &self.owner)
            .finish_non_exhaustive()
    }
}

impl WalSegmentStore {
    pub fn new(
        client: impl Into<HttpClient>,
        cfg: &WalStoreConfig,
        credentials: Arc<CredentialsProvider>,
    ) -> Self {
        Self {
            s3: S3Client::new(
                client,
                &cfg.endpoint,
                cfg.bucket.clone(),
                cfg.region.clone(),
                credentials,
                cfg.timeout,
            ),
            prefix: cfg.prefix.trim_end_matches('/').to_owned(),
            owner: uuid::Uuid::new_v4().to_string(),
            orphan_after: cfg.orphan_after,
            retired: AtomicBool::new(false),
            heartbeat_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn owner(&self) -> &str {
        &self.owner
    }

    fn segment_key(&self, owner: &str, lane_key: &str, seq: u64) -> String {
        format!(
            "{}/{KEY_SCHEME}/segments/{owner}/{lane_key}/{seq:012}.seg",
            self.prefix
        )
    }

    fn owner_key(&self, owner: &str) -> String {
        format!("{}/{KEY_SCHEME}/owners/{owner}", self.prefix)
    }

    fn claim_key(&self, owner: &str) -> String {
        format!("{}/{KEY_SCHEME}/claims/{owner}", self.prefix)
    }

    fn retired_key(&self, owner: &str) -> String {
        format!("{}/{KEY_SCHEME}/retired/{owner}", self.prefix)
    }

    fn listing(&self, kind: &str) -> String {
        format!("{}/{KEY_SCHEME}/{kind}/", self.prefix)
    }

    /// Ship one sealed segment. Overwrites unconditionally: the only writer for
    /// this key is this process, and a retry of a partial PUT must win.
    pub async fn put_segment(
        &self,
        lane_key: &str,
        seq: u64,
        bytes: Vec<u8>,
    ) -> Result<(), S3Error> {
        let key = self.segment_key(&self.owner, lane_key, seq);
        self.s3.put(&key, bytes, false).await
    }

    /// Drop a segment whose frames have exported. Missing is success — the
    /// upload may simply never have happened.
    pub async fn delete_segment(&self, lane_key: &str, seq: u64) -> Result<(), S3Error> {
        let key = self.segment_key(&self.owner, lane_key, seq);
        self.s3.delete(&key).await
    }

    /// Refresh this owner's heartbeat. Liveness is the object's `LastModified`,
    /// so the body carries nothing. Returns `false`, writing nothing, once retired.
    pub async fn heartbeat(&self) -> Result<bool, S3Error> {
        let _guard = self.heartbeat_lock.lock().await;
        if self.retired.load(Ordering::Acquire) {
            return Ok(false);
        }
        self.s3
            .put(&self.owner_key(&self.owner), Vec::new(), false)
            .await?;
        Ok(true)
    }

    /// Mark this owner as gone for good, so a successor claims whatever we
    /// shipped at shutdown right away. Heartbeats stop first, and the marker lands
    /// before the heartbeat is dropped, so the owner is never invisible to `stale_owners`.
    pub async fn retire(&self) -> Result<(), S3Error> {
        self.retire_within(RETIRE_HEARTBEAT_WAIT).await
    }

    pub(crate) async fn retire_within(&self, heartbeat_wait: Duration) -> Result<(), S3Error> {
        // No heartbeat PUT starts after this.
        self.retired.store(true, Ordering::Release);
        // The marker does not wait on an in-flight heartbeat: it is what makes the
        // owner claimable at once, so it must not lose the shutdown budget to one.
        self.s3
            .put(&self.retired_key(&self.owner), Vec::new(), false)
            .await?;
        // The delete does wait, so a heartbeat in flight cannot land after it and
        // recreate the key. A stuck one leaves the key; a successor deletes it on release.
        let Ok(_guard) = tokio::time::timeout(heartbeat_wait, self.heartbeat_lock.lock()).await
        else {
            warn!("A WAL heartbeat is still in flight; leaving the owner key to the successor");
            return Ok(());
        };
        self.s3.delete(&self.owner_key(&self.owner)).await
    }

    /// Owners whose segments are claimable now: retired ones at any age, and
    /// ones whose heartbeat went stale.
    pub async fn stale_owners(&self, now: DateTime<Utc>) -> Result<Vec<String>, S3Error> {
        let heartbeats = self
            .s3
            .list(&self.listing("owners"), MAX_LIST_PAGES)
            .await?;
        let retired = self
            .s3
            .list(&self.listing("retired"), MAX_LIST_PAGES)
            .await?;
        Ok(claimable_owners(
            &self.owner,
            &heartbeats,
            &retired,
            now,
            self.orphan_after,
        ))
    }

    /// Take ownership of a dead task's segments, or report (`None`) that
    /// someone else already has.
    ///
    /// The claim is a conditional PUT: S3 answers 412 when the key exists, which
    /// makes exactly one booting task the winner without a lock service. A claim
    /// older than `CLAIM_LEASE` is taken over, because the task that wrote it
    /// evidently died before finishing; the takeover is `If-Match` on the expired
    /// claim's ETag, so of two tasks taking over the same claim only one wins.
    pub async fn claim(
        &self,
        owner: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<OwnerClaim>, S3Error> {
        let key = self.claim_key(owner);
        match self
            .s3
            .put_with(&key, self.claim_body(), PutCondition::Absent)
            .await
        {
            Ok(etag) => Self::held(owner, etag).map(Some),
            Err(error) if error.status() == Some(412) => {
                let existing = self.s3.list(&key, 1).await?;
                let Some(current) = existing.into_iter().find(|object| object.key == key) else {
                    // Released since our PUT; a later boot claims it if it is still stale.
                    return Ok(None);
                };
                if !is_older_than(&current, now, CLAIM_LEASE) {
                    return Ok(None);
                }
                let condition = current
                    .etag
                    .as_deref()
                    .map_or(PutCondition::Always, PutCondition::Matches);
                match self.s3.put_with(&key, self.claim_body(), condition).await {
                    Ok(etag) => Self::held(owner, etag).map(Some),
                    // Renewed, released or taken over by someone else meanwhile.
                    Err(error) if matches!(error.status(), Some(404 | 412)) => Ok(None),
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        }
    }

    /// Unique per write, so each write's ETag names exactly that write.
    fn claim_body(&self) -> Vec<u8> {
        format!("{} {}", self.owner, uuid::Uuid::new_v4()).into_bytes()
    }

    fn held(owner: &str, etag: Option<String>) -> Result<OwnerClaim, S3Error> {
        let etag = etag.ok_or_else(|| {
            S3Error::Transport("claim PUT returned no ETag to fence renewals with".to_owned())
        })?;
        Ok(OwnerClaim {
            owner: owner.to_owned(),
            etag: std::sync::Mutex::new(etag),
            lost: AtomicBool::new(false),
        })
    }

    /// Re-stamp a held claim, `If-Match` on our last write. `Ok(false)` means
    /// another task holds it now; the claim is marked lost and never renewed again.
    ///
    /// A transport error can hide a PUT that did land, after which the next
    /// renewal sees a foreign ETag and gives the claim up. That only stops this
    /// recovery early; the owner stays claimable once the lease runs out.
    async fn renew(&self, claim: &OwnerClaim) -> Result<bool, S3Error> {
        if claim.is_lost() {
            return Ok(false);
        }
        let current = claim.etag();
        match self
            .s3
            .put_with(
                &self.claim_key(&claim.owner),
                self.claim_body(),
                PutCondition::Matches(&current),
            )
            .await
        {
            Ok(Some(etag)) => {
                claim.set_etag(etag);
                Ok(true)
            }
            Ok(None) => {
                // Landed, but nothing to fence the next write with.
                claim.mark_lost();
                Err(S3Error::Transport(
                    "claim renewal returned no ETag".to_owned(),
                ))
            }
            Err(error) if matches!(error.status(), Some(404 | 412)) => {
                claim.mark_lost();
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    /// Run `work` (one owner's recovery) while keeping this task's claim on the
    /// owner fresh, so a recovery longer than `CLAIM_LEASE` is not taken over
    /// and replayed a second time. If a renewal finds the claim taken over
    /// anyway, it is marked lost; `work` is expected to check and stop.
    pub async fn while_claimed<T>(&self, claim: &OwnerClaim, work: impl Future<Output = T>) -> T {
        self.while_claimed_every(claim, CLAIM_RENEW_EVERY, work)
            .await
    }

    pub(crate) async fn while_claimed_every<T>(
        &self,
        claim: &OwnerClaim,
        every: Duration,
        work: impl Future<Output = T>,
    ) -> T {
        let mut work = std::pin::pin!(work);
        let mut renew = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
        renew.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                out = &mut work => return out,
                _ = renew.tick(), if !claim.is_lost() => match self.renew(claim).await {
                    Ok(true) => {}
                    Ok(false) => warn!(
                        owner = claim.owner,
                        "A WAL owner claim was taken over; stopping this recovery"
                    ),
                    Err(error) => {
                        warn!(owner = claim.owner, error = %error, "Failed to renew a WAL owner claim");
                    }
                },
            }
        }
    }

    /// Every segment a claimed owner left behind, oldest first, without its
    /// bytes: a dead owner's backlog can be far larger than this task's memory.
    ///
    /// Keys sort by `(lane, sequence)` and sequences are zero-padded, so the
    /// listing order is the order the frames were written.
    pub async fn list_segments(&self, owner: &str) -> Result<Vec<OrphanedSegment>, S3Error> {
        let prefix = format!("{}/{KEY_SCHEME}/segments/{owner}/", self.prefix);
        let mut objects = self.s3.list(&prefix, MAX_LIST_PAGES).await?;
        objects.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(objects
            .into_iter()
            .filter_map(|object| {
                let lane_key = lane_key_of(&object.key)?;
                Some(OrphanedSegment {
                    key: object.key,
                    lane_key,
                })
            })
            .collect())
    }

    pub async fn fetch_segment(&self, segment: &OrphanedSegment) -> Result<Vec<u8>, S3Error> {
        self.s3.get(&segment.key).await
    }

    /// Finish a claim: drop the recovered object and, once every segment is
    /// gone, the owner's heartbeat, retired marker and claim marker.
    pub async fn release_key(&self, key: &str) -> Result<(), S3Error> {
        self.s3.delete(key).await
    }

    /// Delete a fully recovered owner's heartbeat, retired marker and claim,
    /// only while this task still holds the claim.
    ///
    /// S3 has no conditional multi-key delete, so the fence is a renewal: it
    /// fails if the claim was taken over, and otherwise starts a fresh
    /// `CLAIM_LEASE` during which no other task can take it. The deletes run
    /// inside that lease. A segment shipped after recovery listed the owner keeps
    /// the markers, so it is never left undiscoverable.
    pub async fn release_owner(&self, claim: &OwnerClaim) -> Result<ClaimRelease, S3Error> {
        if !self.renew(claim).await? {
            return Ok(ClaimRelease::Lost);
        }
        if !self.list_segments(&claim.owner).await?.is_empty() {
            return Ok(ClaimRelease::SegmentsRemain);
        }
        self.s3.delete(&self.owner_key(&claim.owner)).await?;
        self.s3.delete(&self.retired_key(&claim.owner)).await?;
        // The claim goes last: until it does, no other task re-claims the owner.
        self.s3.delete(&self.claim_key(&claim.owner)).await?;
        Ok(ClaimRelease::Released)
    }
}

fn is_older_than(object: &S3Object, now: DateTime<Utc>, age: Duration) -> bool {
    let Some(modified) = object.last_modified else {
        // No timestamp is not evidence of life; treat it as stale so a listing
        // this parser did not understand cannot strand segments forever.
        return true;
    };
    (now - modified)
        .to_std()
        .is_ok_and(|elapsed| elapsed >= age)
}

/// Which owners other than `own` may be claimed, in key order.
fn claimable_owners(
    own: &str,
    heartbeats: &[S3Object],
    retired: &[S3Object],
    now: DateTime<Utc>,
    orphan_after: Duration,
) -> Vec<String> {
    let stale = heartbeats
        .iter()
        .filter(|object| is_older_than(object, now, orphan_after))
        .filter_map(|object| last_component(&object.key));
    // A retired owner shut down on purpose and will never write again, so its
    // age does not matter.
    let retired = retired
        .iter()
        .filter_map(|object| last_component(&object.key));
    let claimable: std::collections::BTreeSet<&str> =
        stale.chain(retired).filter(|owner| *owner != own).collect();
    claimable.into_iter().map(str::to_owned).collect()
}

fn last_component(key: &str) -> Option<&str> {
    key.rsplit('/').next().filter(|part| !part.is_empty())
}

/// `…/segments/<owner>/<lane_key>/<seq>.seg` → `<lane_key>`.
fn lane_key_of(key: &str) -> Option<String> {
    let mut parts = key.rsplit('/');
    parts.next()?; // the segment file
    parts.next().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(key: &str, minutes_ago: i64) -> S3Object {
        S3Object {
            key: key.to_owned(),
            last_modified: Some(Utc::now() - chrono::Duration::minutes(minutes_ago)),
            size: 0,
            etag: None,
        }
    }

    #[test]
    fn lane_key_is_the_directory_above_the_segment() {
        assert_eq!(
            lane_key_of("wal/v1/segments/owner-a/shard-003-clickhouse/000000000012.seg").as_deref(),
            Some("shard-003-clickhouse")
        );
        assert_eq!(lane_key_of("nodirectory.seg").as_deref(), None);
    }

    #[test]
    fn staleness_is_measured_against_the_heartbeat() {
        let now = Utc::now();
        assert!(is_older_than(
            &object("owners/a", 30),
            now,
            DEFAULT_ORPHAN_AFTER
        ));
        assert!(!is_older_than(
            &object("owners/b", 1),
            now,
            DEFAULT_ORPHAN_AFTER
        ));
    }

    #[test]
    fn retired_owners_are_claimable_at_any_age() {
        let heartbeats = [
            object("wal/v1/owners/live", 1),
            object("wal/v1/owners/dead", 30),
            object("wal/v1/owners/me", 30),
        ];
        // Retired a moment ago: no staleness window to wait out.
        let retired = [object("wal/v1/retired/just-retired", 0)];
        assert_eq!(
            claimable_owners(
                "me",
                &heartbeats,
                &retired,
                Utc::now(),
                DEFAULT_ORPHAN_AFTER
            ),
            vec!["dead", "just-retired"]
        );
    }

    #[test]
    fn a_listing_without_a_timestamp_reads_as_stale() {
        // Otherwise an unparsed LastModified would strand the segments under it
        // for good: nobody would ever claim them.
        let unparsed = S3Object {
            key: "owners/c".to_owned(),
            last_modified: None,
            size: 0,
            etag: None,
        };
        assert!(is_older_than(&unparsed, Utc::now(), DEFAULT_ORPHAN_AFTER));
    }
}
