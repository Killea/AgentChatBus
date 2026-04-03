import { describe, expect, it } from "vitest";
import type { CliAdapterActivityEvent } from "../../src/core/services/adapters/types.js";
import {
  buildNativeActivityCard,
  type CliSessionSnapshot,
} from "../../src/core/services/cliSessionManager.js";

function makeDirectSession(
  overrides: Partial<CliSessionSnapshot> = {},
): CliSessionSnapshot {
  return {
    id: overrides.id || "session-1",
    thread_id: overrides.thread_id || "thread-1",
    thread_display_name: overrides.thread_display_name,
    reentry_prompt_override: overrides.reentry_prompt_override,
    adapter: overrides.adapter || "codex",
    mode: overrides.mode || "direct",
    model: overrides.model,
    reasoning_effort: overrides.reasoning_effort,
    state: overrides.state || "running",
    prompt: overrides.prompt || "join the thread",
    prompt_history: overrides.prompt_history,
    initial_instruction: overrides.initial_instruction,
    workspace: overrides.workspace || "C:\\workspace",
    requested_by_agent_id: overrides.requested_by_agent_id || "human",
    participant_agent_id: overrides.participant_agent_id || "agent-1",
    participant_display_name: overrides.participant_display_name || "Codex",
    participant_role: overrides.participant_role || "participant",
    meeting_transport: overrides.meeting_transport || "agent_mcp",
    created_at: overrides.created_at || "2026-03-30T12:00:00.000Z",
    updated_at: overrides.updated_at || "2026-03-30T12:00:05.000Z",
    run_count: overrides.run_count || 1,
    supports_input: overrides.supports_input ?? false,
    supports_restart: overrides.supports_restart ?? true,
    supports_resize: overrides.supports_resize ?? false,
    pid: overrides.pid,
    last_error: overrides.last_error,
    last_result: overrides.last_result,
    raw_result: overrides.raw_result ?? null,
    external_session_id: overrides.external_session_id,
    external_request_id: overrides.external_request_id,
    exit_code: overrides.exit_code,
    stdout_excerpt: overrides.stdout_excerpt,
    stderr_excerpt: overrides.stderr_excerpt,
    output_cursor: overrides.output_cursor || 0,
    cols: overrides.cols,
    rows: overrides.rows,
    shell: overrides.shell,
    screen_excerpt: overrides.screen_excerpt,
    screen_cursor_x: overrides.screen_cursor_x,
    screen_cursor_y: overrides.screen_cursor_y,
    screen_buffer: overrides.screen_buffer,
    interactive_work_state: overrides.interactive_work_state,
    interactive_work_reason: overrides.interactive_work_reason,
    automation_state: overrides.automation_state,
    reply_capture_state: overrides.reply_capture_state,
    reply_capture_excerpt: overrides.reply_capture_excerpt,
    reply_capture_error: overrides.reply_capture_error,
    context_delivery_mode: overrides.context_delivery_mode || "join",
    last_delivered_seq: overrides.last_delivered_seq,
    last_acknowledged_seq: overrides.last_acknowledged_seq,
    last_posted_seq: overrides.last_posted_seq,
    meeting_post_state: overrides.meeting_post_state,
    meeting_post_error: overrides.meeting_post_error,
    last_posted_message_id: overrides.last_posted_message_id,
    launch_started_at: overrides.launch_started_at,
    process_started_at: overrides.process_started_at,
    first_output_at: overrides.first_output_at,
    last_output_at: overrides.last_output_at,
    connected_at: overrides.connected_at || "2026-03-30T12:00:01.000Z",
    last_tool_call_at: overrides.last_tool_call_at,
    recent_tool_events: overrides.recent_tool_events,
    recent_stream_events: overrides.recent_stream_events,
    reentry_prompt: overrides.reentry_prompt,
    recent_activity_events: overrides.recent_activity_events,
    native_turn_runtime: overrides.native_turn_runtime,
    native_activity_card: overrides.native_activity_card,
  };
}

function makeActivity(overrides: Partial<CliAdapterActivityEvent>): CliAdapterActivityEvent {
  return {
    at: overrides.at || "2026-03-30T12:00:04.000Z",
    turn_id: overrides.turn_id,
    item_id: overrides.item_id || "item-1",
    kind: overrides.kind || "thinking",
    status: overrides.status || "in_progress",
    label: overrides.label || "Thinking",
    summary: overrides.summary,
    content: overrides.content,
    server: overrides.server,
    tool: overrides.tool,
    command: overrides.command,
    cwd: overrides.cwd,
    files: overrides.files,
    diff: overrides.diff,
    plan_steps: overrides.plan_steps,
    started_at: overrides.started_at,
    completed_at: overrides.completed_at,
  };
}

describe("buildNativeActivityCard", () => {
  it("shows a Thinking shell state while Codex is actively running", () => {
    const card = buildNativeActivityCard(makeDirectSession({
      native_turn_runtime: {
        updated_at: "2026-03-30T12:00:05.000Z",
        thread_id: "thread-1",
        active_turn_id: "turn-1",
        last_turn_id: "turn-1",
        turn_status: "inProgress",
        phase: "running",
        thread_active_flags: [],
      },
      recent_activity_events: [],
    }));

    expect(card.shell_status_text).toBe("Thinking");
    expect(card.placeholder_visible).toBe(false);
    expect(card.content_sections[0]).toMatchObject({
      kind: "thinking",
      status: "in_progress",
    });
    expect(card.content_sections[0]?.summary).toContain("Working through the next steps");
  });

  it("preserves approval wait state instead of relabeling it as Thinking", () => {
    const card = buildNativeActivityCard(makeDirectSession({
      native_turn_runtime: {
        updated_at: "2026-03-30T12:00:05.000Z",
        thread_id: "thread-1",
        active_turn_id: "turn-1",
        last_turn_id: "turn-1",
        turn_status: "inProgress",
        phase: "running",
        thread_active_flags: ["waitingOnApproval"],
      },
      recent_activity_events: [],
    }));

    expect(card.shell_status_text).toBe("Waiting on approval");
    expect(card.content_sections[0]).toMatchObject({
      kind: "thinking",
      status: "in_progress",
      meta: "Approval required",
    });
    expect(card.content_sections[0]?.summary).toContain("Waiting for approval");
  });

  it("promotes the latest tool activity over stale thinking activity", () => {
    const card = buildNativeActivityCard(makeDirectSession({
      native_turn_runtime: {
        updated_at: "2026-03-30T12:00:05.000Z",
        thread_id: "thread-1",
        active_turn_id: "turn-1",
        last_turn_id: "turn-1",
        turn_status: "inProgress",
        phase: "running",
        thread_active_flags: [],
      },
      recent_activity_events: [
        makeActivity({
          at: "2026-03-30T12:00:02.000Z",
          item_id: "reason-1",
          kind: "thinking",
          status: "in_progress",
          label: "Thinking",
          summary: "Inspecting the thread state.",
        }),
        makeActivity({
          at: "2026-03-30T12:00:04.000Z",
          item_id: "tool-1",
          kind: "mcp_tool_call",
          status: "in_progress",
          label: "Using tool",
          server: "agentchatbus",
          tool: "bus_connect",
          summary: "Joining the thread.",
        }),
      ],
    }));

    expect(card.shell_status_text).toBe("Using tool");
    expect(card.content_sections[0]).toMatchObject({
      kind: "tool",
      status: "in_progress",
    });
    const thinkingSection = card.content_sections.find((section) => section.kind === "thinking");
    expect(thinkingSection).toMatchObject({
      kind: "thinking",
      status: "completed",
    });
  });

  it("marks stale tool activity completed when command execution becomes primary", () => {
    const card = buildNativeActivityCard(makeDirectSession({
      native_turn_runtime: {
        updated_at: "2026-03-30T12:00:05.000Z",
        thread_id: "thread-1",
        active_turn_id: "turn-1",
        last_turn_id: "turn-1",
        turn_status: "inProgress",
        phase: "running",
        thread_active_flags: [],
      },
      recent_activity_events: [
        makeActivity({
          at: "2026-03-30T12:00:02.000Z",
          item_id: "tool-1",
          kind: "mcp_tool_call",
          status: "in_progress",
          label: "Using tool",
          server: "agentchatbus",
          tool: "msg_post",
          summary: "Posting the reply.",
        }),
        makeActivity({
          at: "2026-03-30T12:00:04.000Z",
          item_id: "cmd-1",
          kind: "command_execution",
          status: "in_progress",
          label: "Running command",
          command: "git status",
          cwd: "C:\\workspace",
          summary: "On branch main",
        }),
      ],
    }));

    expect(card.shell_status_text).toBe("Running command");
    expect(card.content_sections[0]).toMatchObject({
      kind: "command",
      status: "in_progress",
    });
    const toolSection = card.content_sections.find((section) => section.kind === "tool");
    expect(toolSection).toMatchObject({
      kind: "tool",
      status: "completed",
    });
  });

  it("keeps the latest task summary after completion", () => {
    const card = buildNativeActivityCard(makeDirectSession({
      state: "completed",
      last_result: "Reply posted",
      raw_result: {
        turn_status: "completed",
      },
      native_turn_runtime: {
        updated_at: "2026-03-30T12:00:05.000Z",
        thread_id: "thread-1",
        active_turn_id: undefined,
        last_turn_id: "turn-1",
        turn_status: "completed",
        phase: "completed",
        thread_active_flags: [],
      },
      recent_activity_events: [
        makeActivity({
          item_id: "task-1",
          kind: "task",
          status: "completed",
          label: "Task",
          summary: "Applied the patch and posted the final reply.",
        }),
      ],
    }));

    const taskSection = card.content_sections.find((section) => section.kind === "task");
    expect(card.shell_status_text).toBe("Completed");
    expect(taskSection).toMatchObject({
      kind: "task",
      status: "completed",
    });
    expect(taskSection?.summary).toContain("Reply posted");
  });

  it("lists explicit command and file activity rows like a native run card", () => {
    const card = buildNativeActivityCard(makeDirectSession({
      native_turn_runtime: {
        updated_at: "2026-03-30T12:00:05.000Z",
        thread_id: "thread-1",
        active_turn_id: "turn-1",
        last_turn_id: "turn-1",
        turn_status: "inProgress",
        phase: "running",
        thread_active_flags: [],
      },
      recent_activity_events: [
        makeActivity({
          at: "2026-03-30T12:00:02.000Z",
          item_id: "reason-1",
          kind: "thinking",
          status: "in_progress",
          label: "Thinking",
          summary: "Checking the chat renderer before editing.",
        }),
        makeActivity({
          at: "2026-03-30T12:00:03.000Z",
          item_id: "cmd-1",
          kind: "command_execution",
          status: "completed",
          label: "Running command",
          command: "node --check web-ui/js/shared-chat.js",
          cwd: "C:\\workspace",
          summary: "Command finished cleanly.",
        }),
        makeActivity({
          at: "2026-03-30T12:00:04.000Z",
          item_id: "files-1",
          kind: "file_change",
          status: "in_progress",
          label: "Editing files",
          summary: "Updating the native activity rows.",
          files: [
            { path: "web-ui/js/shared-chat.js", change_type: "update" },
            { path: "web-ui/css/main.css", change_type: "update" },
          ],
        }),
      ],
    }));

    const commandSection = card.content_sections.find((section) => section.kind === "command");
    const filesSection = card.content_sections.find((section) => section.kind === "files");

    expect(commandSection?.summary).toContain("Ran node --check web-ui/js/shared-chat.js");
    expect(commandSection?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Ran",
        value: "node --check web-ui/js/shared-chat.js",
      }),
      expect.objectContaining({
        label: "Directory",
        value: "C:\\workspace",
      }),
    ]));
    expect(filesSection?.summary).toContain("Edited 2 files");
    expect(filesSection?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Edited file",
        value: "web-ui/js/shared-chat.js",
      }),
      expect.objectContaining({
        label: "Edited file",
        value: "web-ui/css/main.css",
      }),
    ]));
  });

  it("builds content blocks for agent self-talk, commands, and edited files", () => {
    const card = buildNativeActivityCard(makeDirectSession({
      native_turn_runtime: {
        updated_at: "2026-03-30T12:00:10.000Z",
        thread_id: "thread-1",
        active_turn_id: "turn-1",
        last_turn_id: "turn-1",
        turn_status: "inProgress",
        phase: "running",
        thread_active_flags: [],
      },
      recent_activity_events: [
        makeActivity({
          at: "2026-03-30T12:00:02.000Z",
          item_id: "msg-1",
          kind: "agent_message",
          status: "in_progress",
          label: "Message",
          summary: "Checking the renderer before I update it.",
          content: "Checking the renderer before I update it.\nThen I'll verify the command rows.",
        }),
        makeActivity({
          at: "2026-03-30T12:00:04.000Z",
          item_id: "cmd-1",
          kind: "command_execution",
          status: "completed",
          label: "Running command",
          command: "node --check web-ui/js/shared-chat.js",
          cwd: "C:\\workspace",
          summary: "Command finished cleanly.",
          content: "Command finished cleanly.",
          started_at: "2026-03-30T12:00:03.000Z",
          completed_at: "2026-03-30T12:00:05.000Z",
        }),
        makeActivity({
          at: "2026-03-30T12:00:06.000Z",
          item_id: "files-1",
          kind: "file_change",
          status: "completed",
          label: "Editing files",
          summary: "Updated the native activity rows.",
          files: [
            { path: "web-ui/js/shared-chat.js", change_type: "update" },
            { path: "web-ui/css/main.css", change_type: "update" },
          ],
          diff: "@@ -1 +1 @@",
        }),
      ],
    }));

    expect(card.content_blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "message",
        title: "Codex",
      }),
      expect.objectContaining({
        kind: "command",
        title: "Ran node --check web-ui/js/shared-chat.js for 2s",
      }),
      expect.objectContaining({
        kind: "files",
        title: "Edited 2 files",
      }),
      expect.objectContaining({
        kind: "diff",
        title: "Diff",
      }),
    ]));
    const messageBlock = card.content_blocks?.find((block) => block.kind === "message");
    const commandBlock = card.content_blocks?.find((block) => block.kind === "command");
    const filesBlock = card.content_blocks?.find((block) => block.kind === "files");
    expect(messageBlock?.content).toContain("Then I'll verify the command rows.");
    expect(commandBlock?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Directory",
        value: "C:\\workspace",
      }),
      expect.objectContaining({
        label: "Output",
        value: "Command finished cleanly.",
      }),
    ]));
    expect(filesBlock?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Edited file",
        value: "web-ui/js/shared-chat.js",
      }),
      expect.objectContaining({
        label: "Edited file",
        value: "web-ui/css/main.css",
      }),
    ]));
  });

  it("surfaces recent thinking snippets as explicit thought rows", () => {
    const card = buildNativeActivityCard(makeDirectSession({
      native_turn_runtime: {
        updated_at: "2026-03-30T12:00:05.000Z",
        thread_id: "thread-1",
        active_turn_id: "turn-1",
        last_turn_id: "turn-1",
        turn_status: "inProgress",
        phase: "running",
        thread_active_flags: [],
      },
      recent_activity_events: [
        makeActivity({
          at: "2026-03-30T12:00:02.000Z",
          item_id: "plan-1",
          kind: "plan",
          status: "completed",
          label: "Thinking",
          summary: "Check the current native card render path first.",
        }),
        makeActivity({
          at: "2026-03-30T12:00:03.000Z",
          item_id: "task-1",
          kind: "task",
          status: "in_progress",
          label: "Task",
          summary: "Preparing the card update.",
        }),
        makeActivity({
          at: "2026-03-30T12:00:04.000Z",
          item_id: "reason-1",
          kind: "thinking",
          status: "in_progress",
          label: "Thinking",
          summary: "Render explicit command and file rows in the card.",
        }),
      ],
    }));

    const thinkingSection = card.content_sections.find((section) => section.kind === "thinking");
    expect(thinkingSection?.summary).toContain("Render explicit command and file rows in the card.");
    expect(thinkingSection?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Task note",
        value: "Preparing the card update.",
      }),
      expect.objectContaining({
        label: "Plan note",
        value: "Check the current native card render path first.",
      }),
    ]));
  });
});
