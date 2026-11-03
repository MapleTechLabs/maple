"""The security-audit skill's artifact promotion procedure (SKILL.md, Write isolation), run as root.

Usage: promote.py SCRATCH_ROOT ARTIFACTS_ROOT TOTAL_BYTES PROMOTIONS_JSON

PROMOTIONS_JSON is a list of {"path", "maxBytes"}. Prints one JSON object: what was promoted
(path, bytes, sha256, a UTF-8 preview) and what was refused, with why. The executor runs it only
after every process of the agent's command is gone. Both roots are reached through root-owned
parents the agent cannot write, so opening them by path here stands in for descriptors retained
before execution; every step below them is directory-relative and never follows a link.
"""

import errno
import hashlib
import json
import os
import stat
import sys

PREVIEW_BYTES = 4096
CHUNK = 64 * 1024

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
LEAF_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
DEST_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC


class Refused(Exception):
    pass


def components(path):
    """Step 1: no absolute, empty, `.` or `..` component."""
    if not path or path.startswith("/"):
        raise Refused("path must be scratch-relative")
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise Refused("path has an empty, `.` or `..` component")
    if any("\x00" in part for part in parts):
        raise Refused("path has a NUL byte")
    return parts


def open_dir(parent, name):
    try:
        return os.open(name, DIR_FLAGS, dir_fd=parent)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Refused(f"`{name}` is a symlink or not a directory")
        raise


def walk(root, parts):
    """Step 2: each parent component from the root descriptor, never following a link."""
    fd = os.dup(root)
    try:
        for part in parts:
            child = open_dir(fd, part)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def walk_or_create(root, parts):
    """Step 7: existing components must be real directories; missing ones are created exclusively."""
    fd = os.dup(root)
    try:
        for part in parts:
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            child = open_dir(fd, part)
            if not stat.S_ISDIR(os.fstat(child).st_mode):
                os.close(child)
                raise Refused(f"`{part}` is not a directory")
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def identity(st):
    return (st.st_dev, st.st_ino, stat.S_IFMT(st.st_mode), st.st_nlink, st.st_size)


def promote(scratch, artifacts, entry, remaining):
    parts = components(entry["path"])
    limit = min(int(entry["maxBytes"]), remaining)
    parent = walk(scratch, parts[:-1])
    try:
        # Step 3: the leaf, no-follow and nonblocking (a FIFO must not block the open).
        try:
            src = os.open(parts[-1], LEAF_FLAGS, dir_fd=parent)
        except FileNotFoundError:
            raise Refused("no such file in scratch")
        except OSError as error:
            if error.errno == errno.ELOOP:
                raise Refused("the file is a symlink")
            raise
    finally:
        os.close(parent)
    try:
        # Step 4: a regular file, one link, within both limits.
        before = os.fstat(src)
        if not stat.S_ISREG(before.st_mode):
            raise Refused("not a regular file")
        if before.st_nlink != 1:
            raise Refused(f"link count is {before.st_nlink}, not 1")
        if before.st_size > limit:
            raise Refused(f"{before.st_size} bytes exceeds the {limit}-byte limit")
        # Step 5: the limits again while reading, from the same descriptor.
        data = bytearray()
        while True:
            chunk = os.read(src, CHUNK)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > before.st_size or len(data) > limit:
                raise Refused("the file grew while it was read")
        # Step 6: exactly the verified size, and nothing about the file changed.
        if len(data) != before.st_size or identity(os.fstat(src)) != identity(before):
            raise Refused("the file changed while it was read")
    finally:
        os.close(src)
    # Steps 7 and 8: the destination, created exclusively, verified, written from what was read.
    dest_parent = walk_or_create(artifacts, parts[:-1])
    try:
        try:
            dest = os.open(parts[-1], DEST_FLAGS, 0o600, dir_fd=dest_parent)
        except FileExistsError:
            raise Refused("an artifact with this path was already promoted; promote under a new name")
    finally:
        os.close(dest_parent)
    try:
        st = os.fstat(dest)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise Refused("the destination is not a fresh regular file")
        view = memoryview(data)
        while view:
            written = os.write(dest, view)
            view = view[written:]
    finally:
        os.close(dest)
    return {
        "path": entry["path"],
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "preview": bytes(data[:PREVIEW_BYTES]).decode("utf-8", errors="replace"),
    }


def main():
    scratch_root, artifacts_root, total, entries = sys.argv[1], sys.argv[2], int(sys.argv[3]), json.loads(sys.argv[4])
    scratch = os.open(scratch_root, DIR_FLAGS)
    artifacts = os.open(artifacts_root, DIR_FLAGS)
    promoted, rejected, remaining = [], [], total
    for entry in entries:
        try:
            # Step 10 holds by construction: one named file at a time, no globbing, no archives.
            result = promote(scratch, artifacts, entry, remaining)
            remaining -= result["bytes"]
            promoted.append(result)
        except Refused as reason:
            # Step 11: a refused entry is discarded; the caller keeps the lead needs_validation.
            rejected.append({"path": entry["path"], "reason": str(reason)})
        except OSError as error:
            rejected.append({"path": entry["path"], "reason": f"{error.strerror or error}"})
    json.dump({"promoted": promoted, "rejected": rejected}, sys.stdout)


if __name__ == "__main__":
    main()
