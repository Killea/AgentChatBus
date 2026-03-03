import asyncio
from datetime import datetime, timedelta, timezone

import aiosqlite
import pytest

import src.main as app_main
from src.db import crud
from src.db.database import init_schema


async def _setup_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


class _SleepBreaker:
    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, _seconds: float):
        self.calls += 1
        if self.calls > 1:
            raise asyncio.CancelledError()
        return None


@pytest.mark.asyncio
async def test_admin_coordinator_single_agent_emits_confirmation_and_human_notice(monkeypatch):
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "single-agent-intervention")
        agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

        await crud.thread_settings_update(db, thread.id, timeout_seconds=30)

        old_entered = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()
        await db.execute(
            """
            INSERT INTO thread_wait_states (thread_id, agent_id, entered_at, updated_at, timeout_ms)
            VALUES (?, ?, ?, ?, ?)
            """,
            (thread.id, agent.id, old_entered, old_entered, 120000),
        )
        await db.commit()

        sleep_breaker = _SleepBreaker()
        monkeypatch.setattr(app_main.asyncio, "sleep", sleep_breaker)

        async def _fake_get_db():
            return db

        monkeypatch.setattr(app_main, "get_db", _fake_get_db)

        await app_main._admin_coordinator_loop()

        settings = await crud.thread_settings_get_or_create(db, thread.id)
        assert settings.auto_assigned_admin_id is None

        msgs = await crud.msg_list(db, thread.id, after_seq=0, include_system_prompt=False)
        confirmation_msgs = [
            m
            for m in msgs
            if m.metadata and '"ui_type": "admin_switch_confirmation_required"' in m.metadata
        ]
        assert len(confirmation_msgs) == 1
        assert '"candidate_admin_id": "' + agent.id + '"' in (confirmation_msgs[0].metadata or "")

        assert any(
            (m.metadata and "\"visibility\": \"human_only\"" in m.metadata)
            for m in msgs
        )
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_admin_coordinator_multi_agent_emits_confirmation_without_switch(monkeypatch):
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "multi-agent-intervention")
        admin = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")
        peer = await crud.agent_register(db, ide="Cursor", model="GPT-5.3-Codex")

        # Seed participant history so thread participant discovery uses author_id set.
        sync = await crud.issue_reply_token(db, thread_id=thread.id, agent_id=admin.id)
        await crud.msg_post(
            db,
            thread_id=thread.id,
            author=admin.id,
            content="seed-admin",
            expected_last_seq=sync["current_seq"],
            reply_token=sync["reply_token"],
            role="assistant",
        )
        sync2 = await crud.issue_reply_token(db, thread_id=thread.id, agent_id=peer.id)
        await crud.msg_post(
            db,
            thread_id=thread.id,
            author=peer.id,
            content="seed-peer",
            expected_last_seq=sync2["current_seq"],
            reply_token=sync2["reply_token"],
            role="assistant",
        )

        await crud.thread_settings_switch_admin(
            db,
            thread.id,
            admin.id,
            admin.display_name or admin.name or admin.id,
        )
        await crud.thread_settings_update(db, thread.id, timeout_seconds=30)

        old_entered = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()
        await db.execute(
            """
            INSERT INTO thread_wait_states (thread_id, agent_id, entered_at, updated_at, timeout_ms)
            VALUES (?, ?, ?, ?, ?)
            """,
            (thread.id, admin.id, old_entered, old_entered, 120000),
        )
        await db.execute(
            """
            INSERT INTO thread_wait_states (thread_id, agent_id, entered_at, updated_at, timeout_ms)
            VALUES (?, ?, ?, ?, ?)
            """,
            (thread.id, peer.id, old_entered, old_entered, 120000),
        )
        await db.commit()

        sleep_breaker = _SleepBreaker()
        monkeypatch.setattr(app_main.asyncio, "sleep", sleep_breaker)

        async def _fake_get_db():
            return db

        monkeypatch.setattr(app_main, "get_db", _fake_get_db)

        await app_main._admin_coordinator_loop()

        settings = await crud.thread_settings_get_or_create(db, thread.id)
        assert settings.auto_assigned_admin_id == admin.id

        msgs = await crud.msg_list(db, thread.id, after_seq=0, include_system_prompt=False)
        confirmation_msgs = [
            m
            for m in msgs
            if m.metadata and '"ui_type": "admin_switch_confirmation_required"' in m.metadata
        ]
        assert len(confirmation_msgs) == 1
        confirmation_meta = confirmation_msgs[0].metadata or ""
        assert '"current_admin_id": "' + admin.id + '"' in confirmation_meta
        assert '"candidate_admin_id": "' + peer.id + '"' in confirmation_meta

        assert any(
            (m.metadata and "\"visibility\": \"human_only\"" in m.metadata)
            for m in msgs
        )
    finally:
        await db.close()
