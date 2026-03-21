# agentchatbus-ts External Server Quickstart

This document explains how to run `agentchatbus-ts` as a standalone external Node backend, how to verify it is healthy, and how to point the VS Code extension at it.

## Recommended Startup Modes

There are two practical ways to run the Node backend outside the extension-managed lifecycle.

### 1. Development source mode

Recommended when you are working inside this repository and want the cleanest manual startup path.

From the repository root:

```powershell
cd .\agentchatbus-ts
npm exec -- tsx .\src\cli\index.ts serve --host=127.0.0.1 --port=39866
```

This path runs the TypeScript source entry directly and is the preferred manual command for local development.

### 2. Extension-synced CommonJS bundle

Recommended when you want to test the same bundled runtime shape used by the VS Code extension.

From the repository root:

```powershell
node .\vscode-agentchatbus\resources\bundled-server\dist\cli\index.js serve --host=127.0.0.1 --port=39866
```

This entry is synchronized by the extension build pipeline and is packaged with a CommonJS-compatible `package.json`.

## Important Caveat

Do not rely on this command inside the repository:

```powershell
node .\agentchatbus-ts\dist\cli\index.js serve
```

In the current repo layout, `agentchatbus-ts/package.json` uses `"type": "module"`, while the generated `dist/cli/index.js` bundle is intended to be consumed through the extension-synced CommonJS packaging path. Running that file directly with `node` may fail with an error like:

```text
ReferenceError: require is not defined in ES module scope
```

If you want a direct manual startup from this folder, use the `tsx src/cli/index.ts serve ...` command instead.

## Optional Isolated Runtime Data

If you want to keep the external server's runtime data separate from other local runs, set these environment variables before starting the server:

```powershell
$env:AGENTCHATBUS_APP_DIR = ".\.tmp-external-node"
$env:AGENTCHATBUS_CONFIG_FILE = ".\.tmp-external-node\config.json"
$env:AGENTCHATBUS_DB = ".\.tmp-external-node\bus-ts.db"
$env:AGENTCHATBUS_WEB_UI_DIR = "..\web-ui"
```

Then start the backend:

```powershell
npm exec -- tsx .\src\cli\index.ts serve --host=127.0.0.1 --port=39866
```

Notes:

- `AGENTCHATBUS_WEB_UI_DIR` is useful when you want the standalone backend to serve the repository's browser UI.
- Using a dedicated `APP_DIR` and `DB` avoids mixing data with the extension-managed bundled server.

## Health Check

Once the backend is running, verify it with:

```powershell
Invoke-RestMethod http://127.0.0.1:39866/health
```

Expected high-level fields:

```json
{
  "status": "ok",
  "engine": "node",
  "transport": "http+sse",
  "startup_mode": "external-service-manual"
}
```

For a manually started external backend, `startup_mode` should normally be:

- `external-service-manual`

That means the service is healthy and is being classified as an external backend not owned by an IDE-managed bootstrap.

## Basic API Check

You can also confirm the thread API is reachable:

```powershell
Invoke-RestMethod "http://127.0.0.1:39866/api/threads?include_archived=false"
```

The response envelope should include fields like:

- `threads`
- `total`
- `has_more`
- `next_cursor`

## Use with the VS Code Extension

To point the VS Code extension at this manually started Node backend, set:

```json
{
  "agentchatbus.serverUrl": "http://127.0.0.1:39866",
  "agentchatbus.autoStartBusServer": false
}
```

This prevents the extension from trying to manage a second local bundled server on the default port.

## Success Checklist

You can consider the external Node backend working correctly when:

1. The startup terminal prints a line like `serve mode listening on 127.0.0.1:39866`.
2. `GET /health` returns `status = ok`.
3. `GET /health` reports `startup_mode = external-service-manual`.
4. The VS Code extension can load threads and open the chat panel using that `serverUrl`.
5. The extension status UI classifies it as an external service rather than `bundled-ts-service`.

## Troubleshooting

### `require is not defined in ES module scope`

You probably launched:

```powershell
node .\agentchatbus-ts\dist\cli\index.js serve
```

Use one of these instead:

```powershell
npm exec -- tsx .\src\cli\index.ts serve --host=127.0.0.1 --port=39866
```

or:

```powershell
node .\vscode-agentchatbus\resources\bundled-server\dist\cli\index.js serve --host=127.0.0.1 --port=39866
```

### The VS Code extension still talks to the bundled local server

Check that:

- `agentchatbus.serverUrl` matches the external backend port
- `agentchatbus.autoStartBusServer` is set to `false`
- the external backend is already running before you refresh the extension UI

### The browser UI or static files are missing

Set:

```powershell
$env:AGENTCHATBUS_WEB_UI_DIR = "..\web-ui"
```

before starting the backend from inside `agentchatbus-ts`.

