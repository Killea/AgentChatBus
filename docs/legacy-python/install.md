# Legacy Python Backend Installation

!!! warning "Deprecated"
    This page documents the **deprecated Python backend**. It remains available for legacy users
    and self-hosted workflows, but new users should start with the VS Code extension instead.

## Who Should Use This Page

Use this page only if you specifically need the old package/server path.

Otherwise, go to [Install the VS Code Extension](../getting-started/install.md).

---

## Prerequisites

- **Python 3.10+**
- **pip** or **pipx**

---

## Install from PyPI or a Wheel

AgentChatBus is published on PyPI:
<https://pypi.org/project/agentchatbus/>

=== "pipx"

    ```bash
    pipx install agentchatbus
    ```

=== "pip"

    ```bash
    pip install agentchatbus
    ```

=== "Specific version"

    ```bash
    pip install "agentchatbus==0.1.7"
    ```

=== "GitHub Release wheel"

    ```bash
    pip install dist/agentchatbus-0.1.7-py3-none-any.whl
    ```

### Available commands after install

| Command | What it starts | Typical use |
|---|---|---|
| `agentchatbus` | HTTP + SSE MCP server + Web console | Legacy package/server users |
| `agentchatbus-stdio` | MCP stdio server | Legacy stdio/manual client setups |

If the shell cannot find those commands after install, use module mode:

```bash
python -m agentchatbus.cli
python -m agentchatbus.stdio_main --lang English
```

---

## Windows PATH Warning

On Windows you may see:

```text
WARNING: The scripts agentchatbus-stdio.exe and agentchatbus.exe are installed in '...\Scripts' which is not on PATH.
```

This is a Python environment warning, not an AgentChatBus packaging bug.

**Fix option 1 — use `pipx`:**

```powershell
pipx install agentchatbus
pipx ensurepath
```

**Fix option 2 — add Scripts to PATH manually:**

```powershell
$Scripts = python -c "import site, os; print(os.path.join(site.USER_BASE, 'Scripts'))"
$Old = [Environment]::GetEnvironmentVariable("Path", "User")
if ($Old -notlike "*$Scripts*") {
  [Environment]::SetEnvironmentVariable("Path", "$Old;$Scripts", "User")
}
```

**Fix option 3 — use module mode:**

```powershell
python -m agentchatbus.cli
```

---

## Related Legacy Pages

- [Legacy Quick Start](quickstart.md)
- [Manual IDE Connection](manual-ide-connection.md)
- [Source Mode and stdio](source-mode-stdio.md)
- [Configuration](../getting-started/config.md)
