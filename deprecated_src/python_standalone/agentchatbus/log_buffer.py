import io
import re
import sys
import threading
from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True)
class LogEntry:
    id: int
    line: str


_NOISY_LINE_PATTERNS = (
    re.compile(r'"GET /api/logs\?'),
    re.compile(r'"POST /api/ide/heartbeat '),
)


def _should_skip_line(text: str) -> bool:
    if text == "--- Logging error ---":
        return True
    return any(pattern.search(text) for pattern in _NOISY_LINE_PATTERNS)


class _RingBuffer:
    def __init__(self, max_entries: int = 2000):
        self._entries: deque[LogEntry] = deque(maxlen=max_entries)
        self._next_id = 1
        self._lock = threading.Lock()

    def append(self, line: str) -> None:
        text = line.strip()
        if not text:
            return
        if _should_skip_line(text):
            return
        with self._lock:
            entry = LogEntry(id=self._next_id, line=text)
            self._next_id += 1
            self._entries.append(entry)

    def list_after(self, after: int = 0, limit: int = 200) -> list[LogEntry]:
        with self._lock:
            items = [entry for entry in self._entries if entry.id > after]
        return items[:limit]


_buffer = _RingBuffer()


class _TeeStream(io.TextIOBase):
    def __init__(self, underlying: io.TextIOBase):
        self._underlying = underlying
        self._pending = ""
        self._lock = threading.Lock()

    @property
    def encoding(self):
        return getattr(self._underlying, "encoding", "utf-8")

    def fileno(self):
        return self._underlying.fileno()

    def flush(self):
        return self._underlying.flush()

    def isatty(self):
        return self._underlying.isatty()

    def writable(self):
        return True

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)

        with self._lock:
            self._pending += s
            while "\n" in self._pending:
                line, self._pending = self._pending.split("\n", 1)
                _buffer.append(line)

        return self._underlying.write(s)


def install_std_stream_capture() -> None:
    if not isinstance(sys.stdout, _TeeStream):
        sys.stdout = _TeeStream(sys.stdout)
    if not isinstance(sys.stderr, _TeeStream):
        sys.stderr = _TeeStream(sys.stderr)


def get_log_entries(after: int = 0, limit: int = 200) -> list[dict[str, object]]:
    return [
        {"id": entry.id, "line": entry.line}
        for entry in _buffer.list_after(after=after, limit=limit)
    ]