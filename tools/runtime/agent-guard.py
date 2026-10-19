#!/usr/bin/env python3
"""Trusted process guardian. The model never receives the slot or control files."""
import ctypes
import fcntl
import hashlib
import json
import os
import pathlib
import resource
import selectors
import select
import signal
import stat
import subprocess
import sys
import time
import uuid


def durable(path, value):
    path = pathlib.Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(json.dumps(value, sort_keys=True).encode())
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        stat = os.fstat(source.fileno())
        if stat.st_mode & 0o077 or stat.st_size > 65536:
            raise ValueError("Invalid private control file")
        return json.load(source)


def identity(pid):
    try:
        if sys.platform == "linux":
            stat = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return {"pid": pid, "start": stat[19], "group": int(stat[2])}
        result = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "lstart=,pgid="], capture_output=True, text=True, check=True)
        fields = result.stdout.strip().rsplit(None, 1)
        return {"pid": pid, "start": fields[0], "group": int(fields[1])}
    except (OSError, ValueError, IndexError, subprocess.CalledProcessError):
        return None


def boot_identity():
    if sys.platform == "linux":
        return pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    return subprocess.check_output(["/usr/sbin/sysctl", "-n", "kern.boottime"], text=True).strip()


def group_alive(group):
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def reap_descendants(child):
    child.poll()
    if child.returncode is None:
        return False
    try:
        while os.waitpid(-1, os.WNOHANG)[0]:
            pass
        return False
    except ChildProcessError:
        return True


def signal_adopted(signum):
    if sys.platform != "linux":
        return
    # Subreaped Bubblewrap monitors can have a separate process group. Target
    # only this guardian's direct children, using pidfds to avoid PID reuse.
    children = pathlib.Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children")
    for value in children.read_text().split():
        try:
            fd = os.pidfd_open(int(value))
        except ProcessLookupError:
            continue
        try:
            parent = pathlib.Path(f"/proc/{value}/stat").read_text().rsplit(")", 1)[1].split()[1]
            if int(parent) == os.getpid():
                signal.pidfd_send_signal(fd, signum)
        except (ProcessLookupError, FileNotFoundError):
            pass
        finally:
            os.close(fd)


def confirm_cleanup(child, lock, timeout=5):
    # Bubblewrap's leader can disappear before its adopted descendants release
    # inherited descriptors. Group death alone is not the final boundary proof.
    end = time.monotonic() + timeout
    while True:
        reaped = reap_descendants(child)
        acquired = False
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError:
            pass
        if reaped and acquired and not group_alive(child.pid):
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(.02)


def tree_bytes(root):
    total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if not pathlib.Path(directory, name).is_symlink()]
        for name in files:
            item = pathlib.Path(directory, name)
            stat = item.lstat()
            if not item.is_symlink():
                total += stat.st_size
    return total


def cleared_process(record, boot):
    if record["boot"] != boot:
        return True
    complete = pathlib.Path(record["attemptDirectory"], "exit.json")
    if not complete.is_file() or complete.is_symlink():
        return False
    certificate = private_json(complete)
    return (certificate.get("generation") == record["generation"]
            and certificate.get("processStopped") is True
            and (certificate.get("spawned") is False
                 or (isinstance(record.get("group"), int)
                     and not group_alive(record["group"]))))


def main():
    config = private_json(sys.argv[1])
    slot = pathlib.Path(config["slotDirectory"])
    attempt = pathlib.Path(config["attemptDirectory"])
    workspace = pathlib.Path(config["workspace"])
    job_root = pathlib.Path(config["jobRoot"])
    for directory in (slot, attempt, workspace, job_root):
        if not directory.is_absolute() or directory.is_symlink():
            raise ValueError("Invalid private directory")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.stat().st_mode & 0o077:
            raise ValueError("Directory must be private")
    lock = os.open(slot / "execution.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('{"status":"blocked","reason":"slot_owned"}', flush=True)
        return 73
    active = slot / "active.json"
    boot = boot_identity()
    if active.exists():
        prior = private_json(active)
        # A new boot or a matching death certificate proves physical safety.
        if not cleared_process(prior, boot):
            print('{"status":"blocked","reason":"unreconciled_process"}', flush=True)
            return 74
        active.unlink()
        sync_directory(slot)
    if (attempt / "intent.json").exists():
        # Never spend the same launch twice, even after a complete prior result.
        print('{"status":"blocked","reason":"attempt_already_started"}', flush=True)
        return 75
    generation = str(uuid.uuid4())
    record = {"version": 1, "generation": generation, "boot": boot, "guardian": identity(os.getpid()), "attemptDirectory": str(attempt), "attemptId": config["attemptId"], "group": None, "child": None}
    durable(attempt / "intent.json", {**record, "argv": config["argv"], "profileDigest": config["profileDigest"], "inputDigest": config["inputDigest"], "deadline": config["deadline"]})
    durable(active, record)
    # A paused Runner must renew its Service ownership after the guardian owns
    # the physical slot, before any executable can be launched.
    initial = bytearray()
    initial_end = time.monotonic() + config.get("heartbeatTimeoutMs", 15000) / 1000
    admitted = False
    while time.monotonic() < initial_end and len(initial) <= 128:
        if not select.select([sys.stdin.buffer], [], [], .05)[0]:
            continue
        part = os.read(sys.stdin.fileno(), 129)
        if not part:
            break
        initial.extend(part)
        if b"\n" in initial:
            try:
                command, stamp = initial.split(b"\n", 1)[0].split(b" ", 1)
                age = time.time() * 1000 - int(stamp)
                admitted = command == b"heartbeat" and -1000 <= age <= 5000
            except ValueError:
                pass
            break
    if not admitted or time.time() * 1000 >= config["deadline"]:
        durable(attempt / "exit.json", {"version": 1, "generation": generation, "attemptId": config["attemptId"], "processStopped": True, "spawned": False, "exitCode": None, "reason": "launch_lease_missing", "outputDigest": None, "outputBytes": 0, "elapsedMs": 0, "profileDigest": config["profileDigest"], "inputDigest": config["inputDigest"], "completedAt": int(time.time() * 1000)})
        fd = os.open(attempt / "diagnostic.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        active.unlink()
        sync_directory(slot)
        print('{"status":"completed","reason":"launch_lease_missing","processStopped":true}', flush=True)
        return 0
    # Subreaping lets Linux verify/reap orphan grandchildren before freeing the
    # host slot. The deployed sandbox additionally has a private PID namespace.
    if sys.platform == "linux":
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError("Cannot establish child subreaping")
    stop = None
    def request_stop(signum, frame):
        nonlocal stop
        stop = stop or "signal"
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    deadline = config["deadline"] / 1000
    if deadline <= time.time() or deadline > time.time() + 901:
        raise ValueError("Invalid execution deadline")
    argv = config["argv"]
    if not argv or not all(isinstance(arg, str) for arg in argv) or not os.path.isabs(argv[0]):
        raise ValueError("Explicit absolute executable required")
    # Process groups and inherited descriptors cannot contain fork+exec callers
    # that close descriptors. Require a kernel boundary before every spawn.
    if sys.platform == "linux":
        if (argv[0] != "/usr/bin/bwrap" or "--unshare-all" not in argv
                or "--die-with-parent" not in argv or "--new-session" not in argv):
            raise ValueError("Linux execution requires the verified PID boundary")
    elif sys.platform == "darwin":
        # Local probes cannot create descendants at all. Actual subscription
        # execution is rejected by the adapter on macOS.
        argv = ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny process-fork)"] + argv
    else:
        raise ValueError("No verified process boundary")
    # Pass only the dedicated adapter environment; no inherited API fallback.
    allowed_env = {"PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR"}
    if not set(config["env"]).issubset(allowed_env):
        raise ValueError("Unexpected child environment")
    prompt = pathlib.Path(config["inputFile"])
    def child_limits():
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    output_path = pathlib.Path(config["outputFile"])
    os.mkfifo(output_path, 0o600)
    output_fd = os.open(output_path, os.O_RDWR | os.O_NONBLOCK | os.O_NOFOLLOW)
    output_identity = os.fstat(output_fd).st_ino
    output_bytes = bytearray()
    with prompt.open("rb") as input_file:
        child = subprocess.Popen(argv, stdin=input_file, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=workspace, env=config["env"], start_new_session=True, preexec_fn=child_limits, pass_fds=(lock,))
    record.update(group=child.pid, child=identity(child.pid))
    durable(active, record)
    durable(attempt / "process.json", record)
    print(json.dumps({"status": "running", "generation": generation, "pid": child.pid}), flush=True)
    selector = selectors.SelectSelector()
    for stream in (child.stdout, child.stderr, sys.stdin.buffer):
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ)
    selector.register(output_fd, selectors.EVENT_READ)
    heartbeat = time.monotonic()
    started = heartbeat
    last_capacity = 0.0
    control = bytearray()
    diagnostic_size = 0
    diagnostic_truncated = False
    log_fd = os.open(attempt / "diagnostic.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(log_fd, "wb") as log:
        while child.poll() is None and stop is None:
            now = time.monotonic()
            if time.time() >= deadline:
                stop = "deadline"
            elif now - heartbeat >= config.get("heartbeatTimeoutMs", 15000) / 1000:
                stop = "heartbeat_lost"
            if now - last_capacity >= .1:
                last_capacity = now
                if tree_bytes(job_root) > 256 * 1024 * 1024:
                    stop = "workspace_capacity"
                output_path = pathlib.Path(config["outputFile"])
                if not output_path.exists() or output_path.is_symlink() or output_path.stat().st_ino != output_identity or not stat.S_ISFIFO(output_path.stat().st_mode):
                    stop = "output_capacity"
            for key, _ in selector.select(.05):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    if key.fileobj is sys.stdin.buffer:
                        stop = stop or "parent_disconnected"
                    continue
                if key.fd == output_fd:
                    if len(output_bytes) + len(chunk) > 1048576:
                        stop = "output_capacity"
                    else:
                        output_bytes.extend(chunk)
                elif key.fileobj is sys.stdin.buffer:
                    control.extend(chunk)
                    if len(control) > 4096:
                        stop = "invalid_control"
                    while b"\n" in control:
                        line, _, rest = control.partition(b"\n")
                        control = bytearray(rest)
                        if line.startswith(b"heartbeat "):
                            try:
                                age = time.time() * 1000 - int(line.split(b" ", 1)[1])
                                if -1000 <= age <= 5000:
                                    heartbeat = time.monotonic()
                                else:
                                    stop = "stale_heartbeat"
                            except ValueError:
                                stop = "invalid_control"
                        else:
                            stop = "cancelled"
                else:
                    remaining = 8 * 1024 * 1024 - 64 - diagnostic_size
                    log.write(chunk[:max(0, remaining)])
                    diagnostic_size += min(len(chunk), max(0, remaining))
                    if len(chunk) > remaining:
                        diagnostic_truncated = True
            if diagnostic_truncated:
                stop = "diagnostic_capacity"
        # Always clean descendants, including a successful leader's leftovers.
        if group_alive(child.pid):
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        end = time.monotonic() + config.get("graceMs", 10000) / 1000
        while time.monotonic() < end:
            if reap_descendants(child) and not group_alive(child.pid):
                break
            signal_adopted(signal.SIGTERM)
            time.sleep(.02)
        if group_alive(child.pid):
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if reap_descendants(child) and not group_alive(child.pid):
                break
            signal_adopted(signal.SIGKILL)
            time.sleep(.02)
        gone = not group_alive(child.pid)
        # A fast exit can happen before select observes the final diagnostics.
        # Drain only after the entire boundary is dead, so EOF is finite.
        for stream in (child.stdout, child.stderr):
            while True:
                try:
                    chunk = os.read(stream.fileno(), 65536)
                except BlockingIOError:
                    break
                if not chunk:
                    break
                remaining = max(0, 8 * 1024 * 1024 - 64 - diagnostic_size)
                log.write(chunk[:remaining])
                diagnostic_size += min(remaining, len(chunk))
                diagnostic_truncated = diagnostic_truncated or len(chunk) > remaining
        if diagnostic_truncated:
            stop = stop or "diagnostic_capacity"
            log.write(b"\n[diagnostics truncated at configured limit]\n")
        log.flush()
        os.fsync(log.fileno())
    while True:
        try:
            chunk = os.read(output_fd, 65536)
        except BlockingIOError:
            break
        if not chunk:
            break
        if len(output_bytes) + len(chunk) > 1048576:
            stop = "output_capacity"
            break
        output_bytes.extend(chunk)
    os.close(output_fd)
    selector.close()
    # Forked children inherit the same locked open-file description. Even if a
    # child leaves the original group, it must not silently free the host slot.
    # Reopening after closing only our copy detects surviving lock holders.
    os.close(lock)
    lock = os.open(slot / "execution.lock", os.O_RDWR | os.O_NOFOLLOW)
    gone = confirm_cleanup(child, lock)
    if not gone:
        print('{"status":"blocked","reason":"process_cleanup_unconfirmed"}', flush=True)
        return 76
    data = bytes(output_bytes) if stop is None and child.returncode == 0 and output_bytes else None
    if data:
        fd = os.open(attempt / "output.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
    manifest = {"version": 1, "generation": generation, "attemptId": config["attemptId"], "processStopped": True, "exitCode": child.returncode, "reason": stop, "outputDigest": hashlib.sha256(data).hexdigest() if data else None, "outputBytes": len(data) if data else 0, "elapsedMs": int((time.monotonic() - started) * 1000), "profileDigest": config["profileDigest"], "inputDigest": config["inputDigest"], "completedAt": int(time.time() * 1000)}
    durable(attempt / "exit.json", manifest)
    active.unlink()
    sync_directory(slot)
    print(json.dumps({"status": "completed", "reason": stop, "processStopped": True}), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Details may include source paths or provider responses. Keep any active
        # marker for reconciliation; do not declare process death on exceptions.
        print('{"status":"blocked","reason":"guardian_failed"}', flush=True)
        sys.exit(77)
