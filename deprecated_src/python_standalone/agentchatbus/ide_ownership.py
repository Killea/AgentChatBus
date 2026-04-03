from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import secrets
import threading


@dataclass
class IdeSession:
    instance_id: str
    ide_label: str
    session_token: str
    registered_at: datetime
    last_seen: datetime


class IdeOwnershipManager:
    def __init__(self, owner_boot_token: str | None, heartbeat_timeout_seconds: int = 45):
        self._owner_boot_token = owner_boot_token or ""
        self._ownership_assignable = bool(self._owner_boot_token)
        self._had_owner_once = False
        self._heartbeat_timeout = timedelta(seconds=heartbeat_timeout_seconds)
        self._sessions: dict[str, IdeSession] = {}
        self._owner_instance_id: str | None = None
        self._lock = threading.Lock()

    def register(
        self,
        instance_id: str,
        ide_label: str,
        claim_owner: bool,
        owner_boot_token: str | None,
    ) -> dict[str, object]:
        now = datetime.now(timezone.utc)
        with self._lock:
            self._prune_stale_locked(now)
            existing = self._sessions.get(instance_id)
            if existing is None:
                existing = IdeSession(
                    instance_id=instance_id,
                    ide_label=ide_label,
                    session_token=secrets.token_hex(24),
                    registered_at=now,
                    last_seen=now,
                )
                self._sessions[instance_id] = existing
            else:
                existing.ide_label = ide_label
                existing.last_seen = now

            valid_boot_claim = bool(
                claim_owner
                and owner_boot_token
                and secrets.compare_digest(owner_boot_token, self._owner_boot_token)
            )
            implicit_reclaim = bool(
                self._owner_instance_id is None
                and self._ownership_assignable
                and self._had_owner_once
            )

            if self._owner_instance_id is None and self._ownership_assignable and (valid_boot_claim or implicit_reclaim):
                self._owner_instance_id = instance_id
                self._had_owner_once = True

            if valid_boot_claim:
                self._had_owner_once = True

            return self._build_status_locked(instance_id, existing.session_token, False)

    def heartbeat(self, instance_id: str, session_token: str) -> dict[str, object]:
        now = datetime.now(timezone.utc)
        with self._lock:
            session = self._require_session_locked(instance_id, session_token)
            self._prune_stale_locked(now)
            session.last_seen = now
            return self._build_status_locked(instance_id, session.session_token, False)

    def unregister(self, instance_id: str, session_token: str) -> dict[str, object]:
        now = datetime.now(timezone.utc)
        with self._lock:
            self._prune_stale_locked(now)
            session = self._require_session_locked(instance_id, session_token)
            was_owner = self._owner_instance_id == instance_id
            self._sessions.pop(instance_id, None)
            shutdown_requested = False
            transferred_to: str | None = None

            if was_owner:
                if self._sessions:
                    next_owner = min(self._sessions.values(), key=lambda item: item.registered_at)
                    self._owner_instance_id = next_owner.instance_id
                    transferred_to = next_owner.instance_id
                else:
                    self._owner_instance_id = None
                    shutdown_requested = self._ownership_assignable

            return self._build_status_locked(
                instance_id,
                session.session_token,
                True,
                shutdown_requested=shutdown_requested,
                transferred_to=transferred_to,
                was_owner=was_owner,
            )

    def snapshot(self, instance_id: str | None = None, session_token: str | None = None) -> dict[str, object]:
        with self._lock:
            self._prune_stale_locked(datetime.now(timezone.utc))
            token = session_token or ""
            return self._build_status_locked(instance_id, token, False)

    def authorize_shutdown(self, instance_id: str, session_token: str) -> dict[str, object]:
        with self._lock:
            session = self._require_session_locked(instance_id, session_token)
            status = self._build_status_locked(instance_id, session.session_token, False)
            if not status["can_shutdown"]:
                raise PermissionError("This IDE session does not hold shutdown ownership")
            return status

    def _require_session_locked(self, instance_id: str, session_token: str) -> IdeSession:
        session = self._sessions.get(instance_id)
        if session is None:
            raise KeyError("IDE session is not registered")
        if not secrets.compare_digest(session.session_token, session_token):
            raise PermissionError("Invalid IDE session token")
        return session

    def _prune_stale_locked(self, now: datetime) -> None:
        owner_was_removed = False
        expired = [
            instance_id
            for instance_id, session in self._sessions.items()
            if now - session.last_seen > self._heartbeat_timeout
        ]
        for instance_id in expired:
            self._sessions.pop(instance_id, None)
            if self._owner_instance_id == instance_id:
                self._owner_instance_id = None
                owner_was_removed = True

        if self._owner_instance_id is not None and self._owner_instance_id not in self._sessions:
            self._owner_instance_id = None
            owner_was_removed = True

        if owner_was_removed and self._sessions:
            next_owner = min(self._sessions.values(), key=lambda item: item.registered_at)
            self._owner_instance_id = next_owner.instance_id

    def _build_status_locked(
        self,
        instance_id: str | None,
        session_token: str,
        unregistered: bool,
        *,
        shutdown_requested: bool = False,
        transferred_to: str | None = None,
        was_owner: bool = False,
    ) -> dict[str, object]:
        owner = self._sessions.get(self._owner_instance_id or "") if self._owner_instance_id else None
        session = self._sessions.get(instance_id or "") if instance_id else None
        is_owner = bool(instance_id and self._owner_instance_id == instance_id)
        return {
            "instance_id": instance_id,
            "session_token": None if unregistered else (session.session_token if session else session_token or None),
            "registered": bool(session) and not unregistered,
            "ownership_assignable": self._ownership_assignable,
            "owner_instance_id": owner.instance_id if owner else None,
            "owner_ide_label": owner.ide_label if owner else None,
            "is_owner": is_owner,
            "can_shutdown": is_owner,
            "registered_sessions_count": len(self._sessions),
            "registered_sessions": [
                {
                    "instance_id": item.instance_id,
                    "ide_label": item.ide_label,
                    "registered_at": item.registered_at.isoformat(),
                    "last_seen": item.last_seen.isoformat(),
                    "is_owner": item.instance_id == self._owner_instance_id,
                }
                for item in sorted(self._sessions.values(), key=lambda item: item.registered_at)
            ],
            "shutdown_requested": shutdown_requested,
            "transferred_to": transferred_to,
            "was_owner": was_owner,
        }