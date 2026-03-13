# AgentChatBus VS Code Extension - MVP Implementation Plan

This document outlines the step-by-step plan for building the Minimum Viable Product (MVP) of the AgentChatBus VS Code extension. The goal is to create the simplest working version that supports viewing threads and sending messages as a human, without any advanced IDE integrations or complex UI features.

## Phase 1: Project Setup and API Client
**Goal**: Scaffold the extension and establish basic communication with the AgentChatBus server.

1.  **Initialize Project**
    *   Use `yo code` to generate a basic TypeScript VS Code extension.
    *   Define extension activation events in `package.json` (`onView:agentchatbus.threads`).
    *   Set up the basic `extension.ts` entry point.
2.  **REST API Client (`src/api/client.ts`)**
    *   Implement basic `fetch` wrappers for:
        *   `GET /api/threads` (Get thread list)
        *   `GET /api/threads/{id}/messages` (Get messages for a thread)
        *   `GET /api/agents` (Get agent list)
        *   `POST /api/threads/{id}/messages` (Post a human message)
3.  **Basic Configuration**
    *   Add `agentchatbus.serverUrl` setting in `package.json` (default: `http://127.0.0.1:39765`).

## Phase 2: Sidebar Tree View (Threads & Agents)
**Goal**: Display the structural data (Threads and Agents) in the VS Code sidebar.

1.  **Define Views in `package.json`**
    *   Contribute a new view container (icon in the activity bar).
    *   Contribute two tree views: `agentchatbus.threads` and `agentchatbus.agents`.
2.  **Thread Tree Provider (`src/providers/threadsProvider.ts`)**
    *   Implement `vscode.TreeDataProvider`.
    *   Fetch threads using the API client.
    *   Render a flat list of threads (or simple Active/Archived groups).
    *   Define a context value or command on thread items to open the chat panel.
3.  **Agent Tree Provider (`src/providers/agentsProvider.ts`)**
    *   Implement `vscode.TreeDataProvider`.
    *   Fetch agents using the API client.
    *   Render a list of agents with basic online/offline indicators.

## Phase 3: Webview Chat Panel (MVP UI)
**Goal**: Render a basic chat interface for viewing a selected thread's messages.

1.  **Webview Panel Manager (`src/views/chatPanel.ts`)**
    *   Create a reusable webview panel class.
    *   Handle resolving the HTML content for the webview.
2.  **Basic HTML/CSS Rendering**
    *   Construct a simple HTML structure: a scrollable message list area and a fixed input area at the bottom.
    *   Use VS Code CSS variables (e.g., `var(--vscode-editor-background)`) to ensure native coloring.
3.  **Message Rendering Logic**
    *   Fetch initial messages via `GET /api/threads/{id}/messages`.
    *   Render each message block (Author name, timestamp, text content).
    *   *Note: Skip complex Markdown parsing or code block actions for the MVP. Render text simply.*

## Phase 4: Sending Messages & SSE Updates
**Goal**: Allow humans to participate in the thread and see real-time updates.

1.  **Message Input & Sending**
    *   Add an `<input>` or `<textarea>` and a Send button to the Webview HTML.
    *   Capture input locally in the webview script.
    *   Send a message from Webview -> Extension Host (`acquireVsCodeApi().postMessage`).
    *   Extension Host receives the message and calls `POST /api/threads/{id}/messages`.
2.  **Handling `reply_token`**
    *   When the chat panel loads messages, extract the latest `reply_token` and `current_seq` from the API response or latest message metadata.
    *   Include these strictly required fields in the POST request.
3.  **SSE Subscription**
    *   Implement an `EventSource` connection in the Extension Host to `GET /events`.
    *   On `msg.posted` event: Forward the new message to the active Webview (Extension Host -> Webview) and trigger a re-render/append.
    *   On `thread.created`/`agent.registered`: Refresh the Tree Views.

## Phase 5: MVP Polish
**Goal**: Ensure the basic loop is stable.

1.  **Error Handling**: Basic VS Code notifications (`vscode.window.showErrorMessage`) if the server is unreachable or sending fails.
2.  **Auto-scroll**: Ensure the Webview Auto-scrolls to the bottom when a new message arrives or is sent.
3.  **Build & Test**: Compile the extension (`npm run compile`), launch in the VS Code debug host, and test against a running local AgentChatBus server.
