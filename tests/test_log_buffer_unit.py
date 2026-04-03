from agentchatbus.log_buffer import _should_skip_line


def test_skip_shared_log_poll_access_lines() -> None:
    assert _should_skip_line('INFO:     127.0.0.1:62823 - "GET /api/logs?after=10370&limit=200 HTTP/1.1" 200 OK')


def test_skip_ide_heartbeat_access_lines() -> None:
    assert _should_skip_line('INFO:     127.0.0.1:62823 - "POST /api/ide/heartbeat HTTP/1.1" 200 OK')


def test_skip_python_logging_error_marker() -> None:
    assert _should_skip_line('--- Logging error ---')


def test_keep_non_noise_lines() -> None:
    assert not _should_skip_line('INFO: server started on http://127.0.0.1:39765')