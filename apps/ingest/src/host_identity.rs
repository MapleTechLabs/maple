//! Which host a gateway runs on, as resource attributes.
//!
//! WAL commit latency is set by the disk under `/mnt/wal`, and that varies by
//! host. These attributes let a slow `ingest.wal_commit` be grouped by instance,
//! AMI, zone and WAL device. Everything here is best effort: a lookup that fails
//! or times out drops its attributes, and startup waits at most `DETECT_BUDGET`.

use std::path::Path;
use std::time::Duration;

use opentelemetry::KeyValue;
use reqwest::Client;
use serde_json::Value;

const IMDS: &str = "http://169.254.169.254/latest";
const REQUEST_TIMEOUT: Duration = Duration::from_millis(300);
const DETECT_BUDGET: Duration = Duration::from_secs(1);

/// The filesystem a path lives on, from `/proc/self/mountinfo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalMount {
    pub mount_point: String,
    pub fs_type: String,
    pub device: String,
}

/// Resource attributes for this host. Off ECS only the WAL mount is read, so
/// local dev never waits on a metadata endpoint that is not there.
pub async fn detect(wal_dir: &Path) -> Vec<KeyValue> {
    let mut attrs = wal_mount_attributes(wal_dir);
    let Ok(ecs_uri) = std::env::var("ECS_CONTAINER_METADATA_URI_V4") else {
        return attrs;
    };
    let Ok(client) = Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(REQUEST_TIMEOUT)
        .build()
    else {
        return attrs;
    };
    let lookups = async {
        let (ecs, ec2) = tokio::join!(ecs_task(&client, &ecs_uri), ec2_instance(&client));
        ecs.into_iter().chain(ec2).collect::<Vec<_>>()
    };
    if let Ok(found) = tokio::time::timeout(DETECT_BUDGET, lookups).await {
        attrs.extend(found);
    }
    attrs
}

fn wal_mount_attributes(wal_dir: &Path) -> Vec<KeyValue> {
    // Mount points are absolute and symlink-free; a WAL dir not created yet keeps its own path.
    let wal_dir = std::fs::canonicalize(wal_dir)
        .or_else(|_| std::path::absolute(wal_dir))
        .unwrap_or_else(|_| wal_dir.to_path_buf());
    let Some(mount) = std::fs::read_to_string("/proc/self/mountinfo")
        .ok()
        .and_then(|contents| mount_for(&contents, &wal_dir))
    else {
        return Vec::new();
    };
    let mut attrs = Vec::with_capacity(4);
    if let Some(model) = device_model(&mount.device) {
        attrs.push(KeyValue::new("maple.ingest.wal.device_model", model));
    }
    attrs.push(KeyValue::new(
        "maple.ingest.wal.mount_point",
        mount.mount_point,
    ));
    attrs.push(KeyValue::new("maple.ingest.wal.fs_type", mount.fs_type));
    attrs.push(KeyValue::new("maple.ingest.wal.device", mount.device));
    attrs
}

/// The deepest mount containing `path`. Fields per proc(5): the fifth is the
/// mount point, and after the ` - ` separator come the fs type and source.
pub fn mount_for(mountinfo: &str, path: &Path) -> Option<WalMount> {
    mountinfo
        .lines()
        .filter_map(|line| {
            let (left, right) = line.split_once(" - ")?;
            let mount_point = left.split(' ').nth(4)?.replace("\\040", " ");
            let mut right = right.split(' ');
            let fs_type = right.next()?.to_owned();
            let device = right.next()?.to_owned();
            Some(WalMount {
                mount_point,
                fs_type,
                device,
            })
        })
        .filter(|mount| path.starts_with(&mount.mount_point))
        .max_by_key(|mount| mount.mount_point.len())
}

/// `Amazon EC2 NVMe Instance Storage` or `Amazon Elastic Block Store`: the
/// distinction a device name like `/dev/nvme1n1` does not carry.
fn device_model(device: &str) -> Option<String> {
    let name = device.strip_prefix("/dev/")?;
    let class = Path::new("/sys/class/block").join(name);
    [class.join("device/model"), class.join("../device/model")]
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .map(|model| model.trim().to_owned())
        .filter(|model| !model.is_empty())
}

async fn ecs_task(client: &Client, base: &str) -> Vec<KeyValue> {
    let Ok(response) = client.get(format!("{base}/task")).send().await else {
        return Vec::new();
    };
    response
        .json::<Value>()
        .await
        .map(|task| ecs_task_attributes(&task))
        .unwrap_or_default()
}

/// Task metadata v4 fields worth pinning to every span.
pub fn ecs_task_attributes(task: &Value) -> Vec<KeyValue> {
    let mut attrs = vec![
        KeyValue::new("cloud.provider", "aws"),
        KeyValue::new("cloud.platform", "aws_ecs"),
    ];
    [
        ("TaskARN", "aws.ecs.task.arn"),
        ("AvailabilityZone", "cloud.availability_zone"),
        ("LaunchType", "aws.ecs.launchtype"),
    ]
    .iter()
    .filter_map(|(field, key)| Some((*key, task.get(field)?.as_str()?.to_owned())))
    .for_each(|(key, value)| attrs.push(KeyValue::new(key, value)));
    attrs
}

/// IMDSv2: a session token, then one GET per field. A task on Fargate (or with
/// IMDS blocked) gets nothing here, and that is fine.
async fn ec2_instance(client: &Client) -> Vec<KeyValue> {
    let Ok(token) = client
        .put(format!("{IMDS}/api/token"))
        .header("X-aws-ec2-metadata-token-ttl-seconds", "60")
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(token) = token.error_for_status().map(reqwest::Response::text) else {
        return Vec::new();
    };
    let Ok(token) = token.await else {
        return Vec::new();
    };
    let fields = [
        ("instance-id", "host.id"),
        ("instance-type", "host.type"),
        ("ami-id", "host.image.id"),
        ("placement/availability-zone", "cloud.availability_zone"),
    ];
    let values = futures_util::future::join_all(
        fields
            .iter()
            .map(|(path, _)| imds_get(client, &token, path)),
    )
    .await;
    fields
        .iter()
        .zip(values)
        .filter_map(|((_, key), value)| Some(KeyValue::new(*key, value?)))
        .collect()
}

async fn imds_get(client: &Client, token: &str, path: &str) -> Option<String> {
    client
        .get(format!("{IMDS}/meta-data/{path}"))
        .header("X-aws-ec2-metadata-token", token)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOUNTINFO: &str = "\
22 1 259:1 / / rw,noatime shared:1 - xfs /dev/nvme0n1p1 rw\n\
812 790 0:52 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/x\n\
830 812 259:3 / /var/lib/maple-ingest/wal rw,noatime - xfs /dev/nvme1n1 rw,attr2\n\
831 812 0:60 / /var/lib/maple-ingest rw - tmpfs tmpfs rw\n";

    #[test]
    fn picks_the_deepest_mount_holding_the_wal() {
        let mount = mount_for(
            MOUNTINFO,
            Path::new("/var/lib/maple-ingest/wal/shard-000-tinybird"),
        );
        assert_eq!(
            mount,
            Some(WalMount {
                mount_point: "/var/lib/maple-ingest/wal".to_owned(),
                fs_type: "xfs".to_owned(),
                device: "/dev/nvme1n1".to_owned(),
            })
        );
    }

    #[test]
    fn a_wal_on_the_container_root_reports_the_overlay() {
        let mount = mount_for(MOUNTINFO, Path::new("/tmp/wal")).map(|mount| mount.fs_type);
        assert_eq!(mount.as_deref(), Some("overlay"));
    }

    #[test]
    fn a_mount_prefix_that_is_not_a_path_component_does_not_match() {
        let mount = mount_for(MOUNTINFO, Path::new("/var/lib/maple-ingest/wal2"))
            .map(|mount| mount.mount_point);
        assert_eq!(mount.as_deref(), Some("/var/lib/maple-ingest"));
    }

    #[test]
    fn ecs_task_metadata_maps_to_semconv_keys() {
        let task = serde_json::json!({
            "TaskARN": "arn:aws:ecs:us-east-1:1:task/c/abc",
            "AvailabilityZone": "us-east-1b",
            "LaunchType": "EC2",
            "Family": "ignored",
        });
        let attrs: Vec<(String, String)> = ecs_task_attributes(&task)
            .into_iter()
            .map(|kv| (kv.key.to_string(), kv.value.to_string()))
            .collect();
        assert_eq!(
            attrs,
            [
                ("cloud.provider", "aws"),
                ("cloud.platform", "aws_ecs"),
                ("aws.ecs.task.arn", "arn:aws:ecs:us-east-1:1:task/c/abc"),
                ("cloud.availability_zone", "us-east-1b"),
                ("aws.ecs.launchtype", "EC2"),
            ]
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
        );
    }
}
