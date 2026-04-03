"""
AgentChatBus Content Filter

Blocks messages containing known secret patterns (API keys, tokens, private keys)
before they are persisted to the database.

All patterns are configurable via AGENTCHATBUS_CONTENT_FILTER_ENABLED env var.
Detection is regex-based and conservative: only high-confidence patterns are blocked
to avoid false positives in technical conversations.
"""
import re
from typing import Optional


SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"AKIA[0-9A-Z]{16}"),                                    "AWS Access Key ID"),
    (re.compile(r"ASIA[0-9A-Z]{16}"),                                    "AWS Temporary Access Key"),
    (re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}"),       "JWT Token"),
    (re.compile(r"ghp_[A-Za-z0-9]{36}"),                                 "GitHub Personal Access Token"),
    (re.compile(r"gho_[A-Za-z0-9]{36}"),                                 "GitHub OAuth Token"),
    (re.compile(r"ghs_[A-Za-z0-9]{36}"),                                 "GitHub App Token"),
    (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),   "Private Key"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}"),        "OpenAI API Key"),
    (re.compile(r"xox[bprs]-[0-9A-Za-z\-]{10,}"),                       "Slack Token"),
    (re.compile(r"AIza[0-9A-Za-z\-_]{35}"),                             "Google API Key"),
    (re.compile(r"[Aa][Zz][Uu][Rr][Ee][A-Za-z0-9_]{10,}=[A-Za-z0-9+/]{43}="), "Azure Storage Key"),
]


class ContentFilterError(Exception):
    """Raised when a message is blocked by the content filter."""

    def __init__(self, pattern_name: str) -> None:
        self.pattern_name = pattern_name
        super().__init__(f"Content blocked: detected {pattern_name}")


def check_content(text: str) -> tuple[bool, Optional[str]]:
    """
    Scan text for known secret patterns.

    Returns:
        (False, None)           if content is clean
        (True, pattern_label)   if a secret pattern is detected
    """
    for pattern, label in SECRET_PATTERNS:
        if pattern.search(text):
            return True, label
    return False, None
