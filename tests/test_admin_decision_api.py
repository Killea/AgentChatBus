"""Integration tests for human-confirmed admin decision API."""

from concurrent.futures import ThreadPoolExecutor
import uuid

import httpx
import pytest

from tests._constants import TEST_BASE_URL as BASE_URL


def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        resp = client.get("/health")
        if resp.status_code == 200:
            return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server is not reachable at {BASE_URL}")


def _create_thread(client: httpx.Client, creator_id: str, creator_token: str) -> str:
    topic = f"admin-decision-{uuid.uuid4()}"
    resp = client.post(
        "/api/threads",
        json={"topic": topic, "creator_agent_id": creator_id},
        headers={"X-Agent-Token": creator_token},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _register_agent(client: httpx.Client) -> tuple[str, str]:
    resp = client.post(
        "/api/agents/register",
        json={"ide": "VS Code", "model": "GPT-5.3-Codex"},
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    return payload["agent_id"], payload["token"]


def test_admin_decision_switch_then_keep():
    with _build_client() as client:
        _require_server_or_skip(client)
        creator_id, creator_token = _register_agent(client)
        thread_id = _create_thread(client, creator_id, creator_token)
        agent_a, _ = _register_agent(client)
        agent_b, _ = _register_agent(client)

        switch_resp = client.post(
            f"/api/threads/{thread_id}/admin/decision",
            json={"action": "switch", "candidate_admin_id": agent_a},
        )
        assert switch_resp.status_code == 200, switch_resp.text
        assert switch_resp.json()["new_admin_id"] == agent_a

        admin_resp = client.get(f"/api/threads/{thread_id}/admin")
        assert admin_resp.status_code == 200, admin_resp.text
        assert admin_resp.json()["admin_id"] == agent_a

        keep_resp = client.post(
            f"/api/threads/{thread_id}/admin/decision",
            json={"action": "keep", "candidate_admin_id": agent_b},
        )
        assert keep_resp.status_code == 200, keep_resp.text

        admin_resp_after = client.get(f"/api/threads/{thread_id}/admin")
        assert admin_resp_after.status_code == 200, admin_resp_after.text
        assert admin_resp_after.json()["admin_id"] == agent_a

        msgs_resp = client.get(
            f"/api/threads/{thread_id}/messages",
            params={"after_seq": 0, "limit": 200, "include_system_prompt": 0},
        )
        assert msgs_resp.status_code == 200, msgs_resp.text
        msgs = msgs_resp.json()
        system_msgs = [m for m in msgs if m.get("author") == "system" and m.get("role") == "system"]
        assert any("Administrator switched by human decision" in m.get("content", "") for m in system_msgs)
        assert any("Administrator kept by human decision" in m.get("content", "") for m in system_msgs)


def test_admin_decision_switch_replaces_previous_admin():
    with _build_client() as client:
        _require_server_or_skip(client)
        creator_id, creator_token = _register_agent(client)
        thread_id = _create_thread(client, creator_id, creator_token)
        agent_a, _ = _register_agent(client)
        agent_b, _ = _register_agent(client)

        r1 = client.post(
            f"/api/threads/{thread_id}/admin/decision",
            json={"action": "switch", "candidate_admin_id": agent_a},
        )
        assert r1.status_code == 200, r1.text

        r2 = client.post(
            f"/api/threads/{thread_id}/admin/decision",
            json={"action": "switch", "candidate_admin_id": agent_b},
        )
        assert r2.status_code == 200, r2.text
        assert r2.json()["new_admin_id"] == agent_b

        admin_resp = client.get(f"/api/threads/{thread_id}/admin")
        assert admin_resp.status_code == 200, admin_resp.text
        assert admin_resp.json()["admin_id"] == agent_b


def test_thread_creator_agent_is_admin():
    with _build_client() as client:
        _require_server_or_skip(client)
        creator_id, creator_token = _register_agent(client)

        create_resp = client.post(
            "/api/threads",
            json={
                "topic": f"creator-admin-{uuid.uuid4()}",
                "creator_agent_id": creator_id,
            },
            headers={"X-Agent-Token": creator_token},
        )
        assert create_resp.status_code == 201, create_resp.text
        thread_id = create_resp.json()["id"]

        admin_resp = client.get(f"/api/threads/{thread_id}/admin")
        assert admin_resp.status_code == 200, admin_resp.text
        payload = admin_resp.json()
        assert payload["admin_id"] == creator_id
        assert payload["admin_type"] == "creator"


def test_thread_creator_requires_carried_credentials():
    with _build_client() as client:
        _require_server_or_skip(client)
        creator_id, creator_token = _register_agent(client)

        create_resp = client.post(
            "/api/threads",
            json={
                "topic": f"creator-auto-infer-{uuid.uuid4()}",
                "creator_agent_id": creator_id,
            },
            headers={"X-Agent-Token": creator_token},
        )
        assert create_resp.status_code == 201, create_resp.text
        thread_id = create_resp.json()["id"]

        admin_resp = client.get(f"/api/threads/{thread_id}/admin")
        assert admin_resp.status_code == 200, admin_resp.text
        payload = admin_resp.json()
        assert payload["admin_id"] == creator_id
        assert payload["admin_type"] == "creator"


def test_thread_agents_endpoint_returns_thread_scoped_participants_only():
    with _build_client() as client:
        _require_server_or_skip(client)
        creator_id, creator_token = _register_agent(client)
        thread_a = _create_thread(client, creator_id, creator_token)
        thread_b = _create_thread(client, creator_id, creator_token)
        agent_b_id, agent_b_token = _register_agent(client)

        post_resp = client.post(
            f"/api/threads/{thread_a}/messages",
            json={
                "author": agent_b_id,
                "role": "assistant",
                "content": "thread-a message",
            },
            headers={"X-Agent-Token": agent_b_token},
        )
        assert post_resp.status_code == 201, post_resp.text

        list_a = client.get(f"/api/threads/{thread_a}/agents")
        assert list_a.status_code == 200, list_a.text
        ids_a = {a.get("id") for a in list_a.json()}
        assert creator_id in ids_a
        assert agent_b_id in ids_a

        list_b = client.get(f"/api/threads/{thread_b}/agents")
        assert list_b.status_code == 200, list_b.text
        ids_b = {a.get("id") for a in list_b.json()}
        assert creator_id in ids_b
        assert agent_b_id not in ids_b


def test_thread_agents_not_found_includes_runtime_diagnostics():
    with _build_client() as client:
        _require_server_or_skip(client)
        missing_thread_id = str(uuid.uuid4())

        resp = client.get(f"/api/threads/{missing_thread_id}/agents")
        assert resp.status_code == 404, resp.text

        payload = resp.json()
        detail = payload.get("detail")
        assert isinstance(detail, dict)
        assert detail.get("message") == "Thread not found"
        assert detail.get("thread_id") == missing_thread_id
        assert isinstance(detail.get("pid"), int)
        assert detail.get("port") is not None
        assert isinstance(detail.get("db_path"), str)
        assert detail.get("db_path")


def test_admin_decision_source_message_is_single_use():
    with _build_client() as client:
        _require_server_or_skip(client)
        creator_id, creator_token = _register_agent(client)
        thread_id = _create_thread(client, creator_id, creator_token)
        candidate_id, _ = _register_agent(client)

        prompt_resp = client.post(
            f"/api/threads/{thread_id}/messages",
            json={
                "author": creator_id,
                "role": "assistant",
                "content": "Possible administrator offline detected.",
                "metadata": {
                    "ui_type": "admin_switch_confirmation_required",
                    "thread_id": thread_id,
                    "candidate_admin_id": candidate_id,
                },
            },
            headers={"X-Agent-Token": creator_token},
        )
        assert prompt_resp.status_code == 201, prompt_resp.text
        source_message_id = prompt_resp.json()["id"]

        first_resp = client.post(
            f"/api/threads/{thread_id}/admin/decision",
            json={
                "action": "switch",
                "candidate_admin_id": candidate_id,
                "source_message_id": source_message_id,
            },
        )
        assert first_resp.status_code == 200, first_resp.text
        first_payload = first_resp.json()
        assert first_payload["already_decided"] is False
        assert first_payload["new_admin_id"] == candidate_id

        second_resp = client.post(
            f"/api/threads/{thread_id}/admin/decision",
            json={
                "action": "keep",
                "candidate_admin_id": creator_id,
                "source_message_id": source_message_id,
            },
        )
        assert second_resp.status_code == 200, second_resp.text
        second_payload = second_resp.json()
        assert second_payload["already_decided"] is True
        assert second_payload["action"] == "switch"

        admin_resp = client.get(f"/api/threads/{thread_id}/admin")
        assert admin_resp.status_code == 200, admin_resp.text
        assert admin_resp.json()["admin_id"] == candidate_id

        msgs_resp = client.get(
            f"/api/threads/{thread_id}/messages",
            params={"after_seq": 0, "limit": 200, "include_system_prompt": 0},
        )
        assert msgs_resp.status_code == 200, msgs_resp.text
        msgs = msgs_resp.json()
        prompt_msg = next((m for m in msgs if m.get("id") == source_message_id), None)
        assert prompt_msg is not None
        prompt_meta = prompt_msg.get("metadata") or "{}"
        assert '"decision_status": "resolved"' in prompt_meta
        assert '"decision_action": "switch"' in prompt_meta


def test_admin_decision_concurrent_submit_emits_single_switch_event():
    with _build_client() as client:
        _require_server_or_skip(client)
        creator_id, creator_token = _register_agent(client)
        thread_id = _create_thread(client, creator_id, creator_token)
        candidate_id, _ = _register_agent(client)

        prompt_resp = client.post(
            f"/api/threads/{thread_id}/messages",
            json={
                "author": creator_id,
                "role": "assistant",
                "content": "Possible administrator offline detected.",
                "metadata": {
                    "ui_type": "admin_switch_confirmation_required",
                    "thread_id": thread_id,
                    "candidate_admin_id": candidate_id,
                },
            },
            headers={"X-Agent-Token": creator_token},
        )
        assert prompt_resp.status_code == 201, prompt_resp.text
        source_message_id = prompt_resp.json()["id"]

        def _submit_once():
            with _build_client() as local_client:
                return local_client.post(
                    f"/api/threads/{thread_id}/admin/decision",
                    json={
                        "action": "switch",
                        "candidate_admin_id": candidate_id,
                        "source_message_id": source_message_id,
                    },
                )

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(_submit_once) for _ in range(2)]
            responses = [f.result() for f in futures]

        assert all(r.status_code == 200 for r in responses)
        payloads = [r.json() for r in responses]
        assert sum(1 for p in payloads if p.get("already_decided") is False) == 1
        assert sum(1 for p in payloads if p.get("already_decided") is True) == 1

        msgs_resp = client.get(
            f"/api/threads/{thread_id}/messages",
            params={"after_seq": 0, "limit": 200, "include_system_prompt": 0},
        )
        assert msgs_resp.status_code == 200, msgs_resp.text
        msgs = msgs_resp.json()
        switched_msgs = [
            m for m in msgs
            if "Administrator switched by human decision" in (m.get("content") or "")
        ]
        assert len(switched_msgs) == 1


def test_admin_takeover_decision_emits_targeted_instruction_and_cancel_is_recorded():
    with _build_client() as client:
        _require_server_or_skip(client)
        creator_id, creator_token = _register_agent(client)
        thread_id = _create_thread(client, creator_id, creator_token)

        prompt_resp = client.post(
            f"/api/threads/{thread_id}/messages",
            json={
                "author": creator_id,
                "role": "assistant",
                "content": "Only current admin is online and waiting.",
                "metadata": {
                    "ui_type": "admin_takeover_confirmation_required",
                    "thread_id": thread_id,
                    "current_admin_id": creator_id,
                },
            },
            headers={"X-Agent-Token": creator_token},
        )
        assert prompt_resp.status_code == 201, prompt_resp.text
        source_message_id = prompt_resp.json()["id"]

        takeover_resp = client.post(
            f"/api/threads/{thread_id}/admin/decision",
            json={
                "action": "takeover",
                "source_message_id": source_message_id,
            },
        )
        assert takeover_resp.status_code == 200, takeover_resp.text
        takeover_payload = takeover_resp.json()
        assert takeover_payload["action"] == "takeover"
        assert takeover_payload["notified_admin_id"] == creator_id

        msgs_resp = client.get(
            f"/api/threads/{thread_id}/messages",
            params={"after_seq": 0, "limit": 200, "include_system_prompt": 0},
        )
        assert msgs_resp.status_code == 200, msgs_resp.text
        msgs = msgs_resp.json()
        takeover_msgs = [
            m for m in msgs
            if "ui_type\": \"admin_coordination_takeover_instruction\"" in (m.get("metadata") or "")
        ]
        assert len(takeover_msgs) == 1
        assert f'"handoff_target": "{creator_id}"' in (takeover_msgs[0].get("metadata") or "")

        prompt_resp_cancel = client.post(
            f"/api/threads/{thread_id}/messages",
            json={
                "author": creator_id,
                "role": "assistant",
                "content": "Takeover prompt for cancel path.",
                "metadata": {
                    "ui_type": "admin_takeover_confirmation_required",
                    "thread_id": thread_id,
                    "current_admin_id": creator_id,
                },
            },
            headers={"X-Agent-Token": creator_token},
        )
        assert prompt_resp_cancel.status_code == 201, prompt_resp_cancel.text
        source_message_id_cancel = prompt_resp_cancel.json()["id"]

        cancel_resp = client.post(
            f"/api/threads/{thread_id}/admin/decision",
            json={
                "action": "cancel",
                "source_message_id": source_message_id_cancel,
            },
        )
        assert cancel_resp.status_code == 200, cancel_resp.text
        cancel_payload = cancel_resp.json()
        assert cancel_payload["action"] == "cancel"
