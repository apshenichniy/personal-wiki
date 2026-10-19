"""Restartable fixed-target deployment. Code never selects units or shell commands."""
import json
import os
from pathlib import Path
import shutil
import time
from artifact import identity, unpack, verify_provenance, sha256
from state import Records, atomic_json, exclusive, operation_id, schema_version, sync_directory

TARGETS = ("staging", "production")


def validate_request(value):
    if not isinstance(value, dict) or set(value) != {"operationId", "operation", "target", "revision", "digest"}:
        raise ValueError("invalid_request")
    operation_id(value["operationId"])
    if value["operation"] not in ("install", "rollback") or value["target"] not in TARGETS:
        raise ValueError("invalid_operation")
    identity(value["revision"], value["digest"])
    return value


class Engine:
    def __init__(self, root, releases, host):
        self.root, self.releases, self.host = root, releases, host
        self.records = Records(root / "operations")
        self.uploads = root / "uploads"
        self.uploads.mkdir(exist_ok=True, mode=0o700)
        releases.mkdir(parents=True, exist_ok=True, mode=0o755)

    def status(self, op_id):
        value = self.records.get(op_id)
        return {k: value[k] for k in ("operationId", "request", "phase", "error", "updatedAt")}

    def active(self, target):
        path = self.root / f"active-{target}.json"
        return json.loads(path.read_text()) if path.exists() else None

    def previous(self, target):
        active = self.active(target)
        if not active or not active.get("previous"):
            raise ValueError("no_previous_release")
        return active["previous"]

    def resume(self, op_id):
        with exclusive(self.root / "deployment.lock"):
            record = self.records.get(op_id)
            if record["phase"] == "failed":
                record["error"] = None
                self.records.put(record, record["resumePhase"])
            return self.status(op_id)

    def rollback(self, op_id, target):
        operation_id(op_id)
        if target not in TARGETS:
            raise ValueError("invalid_target")
        with exclusive(self.root / "deployment.lock"):
            # Resolve the predecessor once: retries refer to the durable request,
            # even after the successful rollback has changed the predecessor.
            if self.records.path(op_id).exists():
                request = self.records.get(op_id)["request"]
                if request["operation"] != "rollback" or request["target"] != target:
                    raise ValueError("operation_conflict")
                return self.status(op_id)
            previous = self.previous(target)
            request = validate_request({"operationId": op_id, "operation": "rollback", "target": target,
                                        "revision": previous["revision"], "digest": previous["digest"]})
            folder = self.uploads / op_id
            folder.mkdir(mode=0o700, exist_ok=True)
            for name in ("artifact.tar.gz", "attestation.jsonl"):
                destination = folder / name
                if not destination.exists():
                    os.link(self.root / "artifacts" / previous["digest"] / name, destination)
            sync_directory(folder)
            self.records.create(request)
            return self.status(op_id)

    def critical_owner(self):
        path = self.root / "inflight.json"
        if not path.exists():
            return None
        op_id = json.loads(path.read_text())["operationId"]
        if self.records.get(op_id)["phase"] == "complete":
            path.unlink()
            sync_directory(self.root)
            return None
        return op_id

    def recovery_gate(self, record, schema):
        if record["request"]["target"] != "production":
            return
        # P12's root-owned backup service issues this capability only after an
        # independently restorable checkpoint. Deploy callers cannot issue it.
        proof = self.root / "recovery" / f'{record["operationId"]}.json'
        if not proof.is_file() or proof.is_symlink() or proof.stat().st_uid != 0 or proof.stat().st_mode & 0o077:
            raise ValueError("verified_backup_required")
        data = json.loads(proof.read_text())
        if (data.get("operationId") != record["operationId"] or data.get("target") != "production" or
            data.get("schema") != schema or data.get("verified") is not True or
            data.get("checkpoint") != self.host.checkpoint_identity("production") or
            not isinstance(data.get("completedAt"), int) or not 0 <= time.time() - data["completedAt"] <= 3600):
            raise ValueError("backup_checkpoint_mismatch")

    def drive(self, op_id):
        with exclusive(self.root / "deployment.lock"):
            record = self.records.get(op_id)
            owner = self.critical_owner()
            if owner is not None and owner != op_id:
                raise ValueError("unfinished_deployment_requires_resume")
            if record["phase"] == "complete":
                return self.status(op_id)
            if record["phase"] == "failed":
                record["phase"] = record["resumePhase"]
                record["error"] = None
            req = record["request"]
            target, digest, revision = req["target"], req["digest"], req["revision"]
            release = self.releases / digest
            try:
                if record["phase"] == "uploaded":
                    upload = self.uploads / op_id
                    self.host.verify(upload / "artifact.tar.gz", upload / "attestation.jsonl", revision, digest)
                    temporary = self.releases / (digest + ".installing")
                    if temporary.exists():
                        shutil.rmtree(temporary)
                    unpack(upload / "artifact.tar.gz", temporary, revision)
                    for file in temporary.rglob("*"):
                        if file.is_file():
                            with file.open("rb") as stream:
                                os.fsync(stream.fileno())
                    for directory in sorted((p for p in temporary.rglob("*") if p.is_dir()), reverse=True):
                        sync_directory(directory)
                    sync_directory(temporary)
                    if release.exists():
                        expected = {str(p.relative_to(temporary)): sha256(p) for p in temporary.rglob("*") if p.is_file()}
                        actual = {}
                        for file in release.rglob("*"):
                            if file.is_symlink():
                                raise ValueError("installed_release_changed")
                            if file.is_file():
                                actual[str(file.relative_to(release))] = sha256(file)
                        if actual != expected:
                            raise ValueError("installed_release_changed")
                        shutil.rmtree(temporary)
                    else:
                        os.rename(temporary, release)
                    sync_directory(self.releases)
                    cache = self.root / "artifacts" / digest
                    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
                    for name in ("artifact.tar.gz", "attestation.jsonl"):
                        if not (cache / name).exists():
                            os.link(upload / name, cache / name)
                    sync_directory(cache)
                    record["previous"] = self.active(target)
                    if req["operation"] == "rollback" and self.previous(target)["digest"] != digest:
                        raise ValueError("rollback_target_mismatch")
                    self.records.put(record, "verified")
                manifest = json.loads((release / "release.json").read_text())
                if record["phase"] == "verified":
                    self.host.preflight(target, manifest)
                    if shutil.disk_usage(self.releases).free < 5 * 1024**3:
                        raise ValueError("insufficient_disk_headroom")
                    atomic_json(self.root / "inflight.json", {"operationId": op_id})
                    self.records.put(record, "checkpointing")
                if record["phase"] == "checkpointing":
                    # Stop dispatch on both namespaces. Unit cgroups fence every
                    # descendant; then check the canonical lock inodes are free.
                    self.host.stop_runners()
                    self.host.stop_service(target)
                    self.host.assert_fenced(target)
                    schema = self.host.schema(target)
                    compatibility = manifest["schema"]
                    if schema and not compatibility["readableMin"] <= schema <= compatibility["readableMax"]:
                        raise ValueError("incompatible_schema")
                    if req["operation"] == "rollback" and schema != compatibility["target"]:
                        raise ValueError("incompatible_rollback")
                    self.recovery_gate(record, schema)
                    record["checkpoint"] = self.host.checkpoint_identity(target)
                    self.records.put(record, "checkpointed")
                    self.host.checkpoint("checkpointed")
                if record["phase"] == "checkpointed":
                    # Reconcile an interrupted cut before changing the symlink.
                    self.host.stop_runners()
                    self.host.stop_service(target)
                    self.host.assert_fenced(target)
                    if record["checkpoint"] != self.host.checkpoint_identity(target):
                        raise ValueError("checkpoint_changed")
                    current = self.releases.parent / f"current-{target}"
                    temporary = current.with_suffix(".next")
                    temporary.unlink(missing_ok=True)
                    temporary.symlink_to(release)
                    os.replace(temporary, current)
                    sync_directory(current.parent)
                    self.records.put(record, "activated")
                    self.host.checkpoint("activated")
                if record["phase"] == "activated":
                    self.host.start_service(target)
                    self.host.readiness(target, release)
                    self.records.put(record, "healthy")
                if record["phase"] == "healthy":
                    prior = record["previous"]
                    # Keep only one predecessor, but all verified bytes remain.
                    previous = {k: prior[k] for k in ("digest", "revision")} if prior else None
                    active = {"digest": digest, "revision": revision, "previous": previous, "operationId": op_id}
                    atomic_json(self.root / f"active-{target}.json", active)
                    self.host.resume_dispatch(target)
                    self.records.put(record, "complete")
                    self.critical_owner()
            except Exception as error:
                record["resumePhase"] = record["phase"]
                record["error"] = str(error) if isinstance(error, ValueError) else "deployment_failed"
                self.records.put(record, "failed")
            return self.status(op_id)
