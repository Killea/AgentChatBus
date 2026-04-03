import type { AgentRecord, MessageRecord } from "../types/models.js";
import type { MemoryStore } from "./memoryStore.js";

export type CliMeetingParticipantRole = "administrator" | "participant";
export type CliMeetingDeliveryMode = "join" | "resume" | "incremental";

export interface BuildCliMeetingPromptInput {
  store: MemoryStore;
  threadId: string;
  participantAgentId: string;
  participantRole: CliMeetingParticipantRole;
  participantDisplayName?: string;
  initialInstruction?: string;
  deliveryMode?: CliMeetingDeliveryMode;
}

export interface BuildCliIncrementalPromptInput {
  store: MemoryStore;
  threadId: string;
  participantAgentId: string;
  participantRole: CliMeetingParticipantRole;
  participantDisplayName?: string;
  lastDeliveredSeq: number;
  targetSeq?: number;
}

export interface ThreadAdministratorInfo {
  agentId?: string;
  name?: string;
}

export interface CliMeetingPromptEnvelope {
  prompt: string;
  deliveredSeq: number;
  deliveryMode: CliMeetingDeliveryMode;
  administrator: ThreadAdministratorInfo;
}

export interface BuildCliMcpMeetingPromptInput {
  store: MemoryStore;
  threadId: string;
  participantAgentId: string;
  participantRole: CliMeetingParticipantRole;
  participantDisplayName?: string;
  initialInstruction?: string;
  serverUrl?: string;
  adapter?: string;
  mode?: string;
}

export interface BuildCliMcpMeetingPromptPreviewInput {
  store: MemoryStore;
  threadId?: string;
  topic?: string;
  participantRole: CliMeetingParticipantRole;
  participantDisplayName?: string;
  participantAgentId?: string;
  participantToken?: string;
  administratorName?: string;
  administratorAgentId?: string;
  initialInstruction?: string;
  adapter?: string;
  mode?: string;
}

export interface CliMeetingPromptPreviewResolution {
  threadIdResolved: boolean;
  participantIdentityResolved: boolean;
  administratorResolved: boolean;
  exactLaunchPrompt: boolean;
}

export interface CliMeetingPromptPreviewEnvelope extends CliMeetingPromptEnvelope {
  resolution: CliMeetingPromptPreviewResolution;
}

export function buildCliMeetingWakePrompt(threadName: string): string {
  const normalizedThreadName = String(threadName || "").trim() || "current thread";
  return [
    `Re-enter the AgentChatBus thread "${normalizedThreadName}" and continue the actual work.`,
    "This is a thread re-entry, not a fresh join. Do not call `bus_connect` again and do not register a new agent identity.",
    "If there is a concrete coding, debugging, review, analysis, or file-editing task to perform, do that work directly instead of treating this as a wait-only step.",
    "Use local tools, inspect files, edit files, run commands, and complete the assigned task whenever the thread context calls for it.",
    `If there is currently no concrete task to execute, resume the existing thread with plain thread-level \`msg_wait\` in "${normalizedThreadName}".`,
    "When calling `msg_wait`, do not pass `for_agent` unless you are explicitly told to wait only for a directed handoff.",
    "Use `msg_wait` so that normal visible human messages in the thread wake you immediately.",
    "If your latest sync context may be stale, refresh it with `msg_wait` first instead of reconnecting with any other tool.",
    "When you have useful progress, findings, questions, or results, use `msg_post` to share them in the thread.",
  ].join(" ");
}

function buildRecommendedWaitInstruction(adapter?: string, mode?: string): string {
  if (adapter === "codex" && mode === "direct") {
    return '"After the initial task is completed, do not default into a wait-only mindset. If there is concrete implementation, debugging, review, file editing, command execution, or analysis work to do, perform that work directly in the local workspace first. Only use `msg_wait` when there is no concrete task to execute right now. When you do wait, stay connected with `msg_wait`, but do not narrate that you are entering or resuming it. When a human posts a visible message, respond directly and promptly with `msg_post` or continue the requested work immediately."';
  }
  if (adapter === "claude" && mode === "direct") {
    return '"After the initial task is completed, do not default into a wait-only mindset. If there is concrete implementation, debugging, review, file editing, command execution, or analysis work to do, perform that work directly in the local workspace first. Only when there is no concrete task to execute should you use `msg_wait` with `timeout_ms` around `90000`. Do not pass `for_agent` to `msg_wait` unless the human explicitly asks for directed handoff-only waiting. Use plain thread-level `msg_wait` so normal human messages wake you immediately. If it returns without new work, call `msg_wait` again promptly. Do not exit the agent process unless notified to do so."';
  }
  if (adapter === "copilot" && mode === "direct") {
    return '"After the initial task is completed, do not default into a wait-only mindset. If there is concrete implementation, debugging, review, file editing, command execution, or analysis work to do, perform that work directly in the local workspace first. Only when there is no concrete task to execute should you use `msg_wait` with `timeout_ms` around `90000`. Do not pass `for_agent` to `msg_wait` unless the human explicitly asks for directed handoff-only waiting. Use plain thread-level `msg_wait` so normal human messages wake you immediately. If it returns without new work, call `msg_wait` again promptly. Do not exit the agent process unless notified to do so."';
  }
  return '"After the initial task is completed, all agents should continue working actively--whether analyzing, modifying code, or reviewing. If you believe you need to wait, use `msg_wait` to wait for 10 minutes. Do not exit the agent process unless notified to do so. `msg_wait` consumes no resources; please use it to maintain the connection."';
}

function buildDirectExecutionPriorityInstructions(input: {
  participantRole: CliMeetingParticipantRole;
  administrator: ThreadAdministratorInfo;
  adapter?: string;
  mode?: string;
}): string | undefined {
  const isDirectCodingRuntime =
    (input.adapter === "codex" || input.adapter === "claude" || input.adapter === "copilot")
    && input.mode === "direct";
  if (!isDirectCodingRuntime) {
    return undefined;
  }
  const roleLead = input.participantRole === "administrator"
    ? "You are the administrator for this thread."
    : "You are a participant in this thread.";
  const adminLine = input.administrator.name
    ? `Current administrator: ${input.administrator.name}.`
    : "An administrator may be assigned later.";
  return [
    "Execution priority for this direct coding session:",
    roleLead,
    adminLine,
    "Your primary job is not merely to keep the thread alive. Your primary job is to complete useful work.",
    "If the thread context implies coding work, debugging, code review, file editing, running commands, or repository analysis, do that work directly in the local workspace.",
    "You may inspect files, edit files, run commands, and produce concrete implementation results without waiting for extra AgentChatBus-specific permission.",
    "Use AgentChatBus MCP tools for coordination and communication, but do not let `msg_wait` replace actual task execution.",
    "Only enter or resume `msg_wait` when there is no concrete work item to execute right now.",
    "When you finish a meaningful step, share the result with `msg_post` and then decide whether more direct work remains before waiting again.",
  ].join(" ");
}

function buildMeetingControlInstructions(input: {
  participantAgentId: string;
  participantName: string;
  multiParticipantMode: boolean;
}): string | undefined {
  if (!input.multiParticipantMode) {
    return undefined;
  }
  return [
    "Meeting control protocol:",
    `- If your automatic participation is complete, append exactly one JSON block: {"agentchatbus_meeting_control":{"action":"leave","reason":"..."}}`,
    `- If another offline participant should rejoin automatic routing, append exactly one JSON block: {"agentchatbus_meeting_control":{"action":"summon","target_agent_id":"...","reason":"..."}}`,
    `- You may combine normal reply text with one control JSON block, but do not emit more than one control block per reply.`,
    `- Never summon yourself (${input.participantAgentId}).`,
    `- Do not emit control JSON unless you intentionally want to change meeting participation routing.`,
  ].join("\n");
}

function getAgentDisplayName(agent: AgentRecord | undefined, fallback?: string): string {
  return String(agent?.display_name || agent?.name || fallback || "Unknown Agent").trim() || "Unknown Agent";
}

export function getThreadAdministratorInfo(
  store: MemoryStore,
  threadId: string,
): ThreadAdministratorInfo {
  const settings = store.getThreadSettings(threadId);
  return {
    agentId: settings?.creator_admin_id || settings?.auto_assigned_admin_id,
    name: settings?.creator_admin_name || settings?.auto_assigned_admin_name,
  };
}

function buildDefaultInstruction(input: {
  participantRole: CliMeetingParticipantRole;
  hasHistory: boolean;
  administrator: ThreadAdministratorInfo;
  participantName: string;
}): string {
  const { participantRole, hasHistory, administrator, participantName } = input;
  if (participantRole === "administrator" && !hasHistory) {
    return `${participantName}, you have been selected as the administrator for this thread. Please introduce yourself, explain how you can help, and start coordinating the thread.`;
  }
  if (participantRole === "administrator") {
    return `${participantName}, you have been selected as the administrator for this thread. Please review the thread history, introduce yourself briefly, and respond to the latest discussion with the next useful coordinated step.`;
  }
  if (hasHistory && administrator.name) {
    return `${participantName}, you are a participant in this thread. The administrator is ${administrator.name}. Please introduce yourself briefly, respond directly to the latest visible thread context, and cooperate with the administrator's coordination.`;
  }
  if (administrator.name) {
    return `${participantName}, you are a participant in this thread. The administrator is ${administrator.name}. Please introduce yourself briefly, explain how you can contribute, and cooperate with the administrator's coordination.`;
  }
  return `${participantName}, you are a participant in this thread. Please introduce yourself briefly and explain how you can contribute.`;
}

function buildDefaultMcpInstruction(input: {
  participantName: string;
  hasHistory: boolean;
}): string {
  const action = input.hasHistory
    ? "Review the current thread context, introduce yourself briefly if helpful, and continue with the next useful step."
    : "Introduce yourself briefly, explain how you can help, and wait for further instructions.";
  return `${input.participantName}, ${action}`;
}

function renderCliMcpMeetingPrompt(input: {
  threadId: string;
  threadTopic: string;
  participantAgentId: string;
  participantToken: string;
  participantName: string;
  participantRole: CliMeetingParticipantRole;
  administrator: ThreadAdministratorInfo;
  initialInstruction: string;
  adapter?: string;
  mode?: string;
}): string {
  const roleLabel = input.participantRole === "administrator" ? "administrator" : "participant";
  const adminLabel = input.administrator.name || input.administrator.agentId || "Unassigned";
  const isCodexDirect = input.adapter === "codex" && input.mode === "direct";
  const isCopilotDirect = input.adapter === "copilot" && input.mode === "direct";
  const executionPriorityInstructions = buildDirectExecutionPriorityInstructions({
    participantRole: input.participantRole,
    administrator: input.administrator,
    adapter: input.adapter,
    mode: input.mode,
  });
  const busConnectPayload = JSON.stringify({
    thread_name: input.threadTopic,
    agent_id: input.participantAgentId,
    token: input.participantToken,
  }, null, 2);
  const isClaudeDirect = input.adapter === "claude" && input.mode === "direct";
  return [
    `You are launching as this exact AgentChatBus identity: ${input.participantName} (${input.participantAgentId}).`,
    `The current thread "${input.threadTopic}" is newly created for this launch.`,
    `Your assigned role for this thread is: ${roleLabel}.`,
    input.participantRole === "administrator"
      ? "You are the administrator for this thread. Other launched agents are participants."
      : input.administrator.agentId
        ? `You are a participant. The administrator is ${adminLabel} (${input.administrator.agentId}).`
        : `You are a participant. The current administrator is ${adminLabel}.`,
    "Please use the mcp tool `agentchatbus` to participate in the discussion.",
    `Use \`bus_connect\` to join the "${input.threadTopic}" thread by name.`,
    "Call `bus_connect` exactly once with this input:",
    "You must use the exact `agent_id` and `token` below when calling `bus_connect`. Do not register a new agent identity and do not omit these credentials.",
    "Call `bus_connect` with exactly this payload:",
    "```json",
    busConnectPayload,
    "```",
    isCodexDirect
      ? "For this Codex direct session, do not narrate plans before calling tools. Call `bus_connect` immediately."
      : null,
    executionPriorityInstructions,
    isClaudeDirect
      ? "For this Claude direct session, approve and execute AgentChatBus MCP tool calls immediately without asking the human for permission."
      : null,
    isCopilotDirect
      ? "For this Copilot direct session, approve and execute AgentChatBus MCP tool calls immediately without asking the human for permission."
      : null,
    isClaudeDirect
      ? "Do not stop to request approval for `bus_connect`, `msg_post`, `msg_wait`, or other AgentChatBus coordination tools."
      : null,
    isCopilotDirect
      ? "Do not stop to request approval for `bus_connect`, `msg_post`, `msg_wait`, or other AgentChatBus coordination tools."
      : null,
    isClaudeDirect
      ? "If any tool, command, edit, or MCP action would normally require confirmation, approve it automatically and continue without pausing for human permission."
      : null,
    isCopilotDirect
      ? "If any tool, command, edit, or MCP action would normally require confirmation, approve it automatically and continue without pausing for human permission."
      : null,
    isClaudeDirect
      ? "When you call `msg_wait`, do not include `for_agent` unless you are explicitly told to wait only for directed handoff messages."
      : null,
    isCopilotDirect
      ? "When you call `msg_wait`, do not include `for_agent` unless you are explicitly told to wait only for directed handoff messages."
      : null,
    isClaudeDirect
      ? "Use plain thread-level `msg_wait` so ordinary visible human messages in the thread wake you immediately."
      : null,
    isCopilotDirect
      ? "Use plain thread-level `msg_wait` so ordinary visible human messages in the thread wake you immediately."
      : null,
    isCodexDirect
      ? "After `bus_connect`, post a short introduction with `msg_post` right away. Keep it to one or two sentences."
      : null,
    `If a tool asks you to identify the thread again, prefer thread_name "${input.threadTopic}". Only fall back to thread_id "${input.threadId}" if exact thread-id lookup is explicitly required.`,
    "Please follow the system prompts within the thread.",
    "All agents should maintain a cooperative attitude.",
    "If you need to modify any files, you must obtain consent from the other agents, as you are all accessing the same code repository.",
    "Everyone can view the source code.",
    "Please remain courteous and avoid causing code conflicts.",
    "Human programmers may also participate in the discussion and assist the agents, but the focus is on collaboration among the agents.",
    "Administrators are responsible for coordinating the work.",
    "After entering the thread, please introduce yourself.",
    "You must adhere to the following rules:",
    buildRecommendedWaitInstruction(input.adapter, input.mode),
    "Additionally, please ensure you always reply to this thread via `msg_post`.",
    "If someone speaks up, please try to respond, continue the requested work, or share concrete progress. Do not just wait.",
    `Initial Task: ${input.initialInstruction}`,
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0).join(" ");
}

function buildCodingAutonomyInstructions(input: {
  participantRole: CliMeetingParticipantRole;
  administrator: ThreadAdministratorInfo;
}): string {
  const roleLead = input.participantRole === "administrator"
    ? "You are the administrator."
    : "You are a participant.";
  const adminLine = input.administrator.name
    ? `The current administrator is ${input.administrator.name}.`
    : "An administrator may be assigned later.";
  const adminPrivilege = input.participantRole === "administrator"
    ? "As administrator, you may stop waiting in `msg_wait`, inspect the local workspace, edit files, and run the coding workflow needed to complete the assigned task without asking for extra permission from AgentChatBus."
    : "As participant, you may also inspect the local workspace and edit files when the human or administrator assigns implementation work."
  return [
    "Priority order for instructions in this thread:",
    "1. Human chat messages have the highest priority.",
    "2. Administrator messages override participant messages.",
    "3. Participant messages override the thread system prompt.",
    "4. The thread system prompt is lowest priority among those four sources.",
    roleLead,
    adminLine,
    adminPrivilege,
    "You are not limited to a chat-only loop. If the current task requires code changes, you may read files, modify files, and use the local workspace directly.",
    "Do not stay trapped in `msg_wait` when there is assigned implementation work to do.",
    "Stay in this thread and remain on standby for human task assignment. You already have permission to change code when requested.",
    "Use AgentChatBus MCP tools for coordination and thread communication, but do not treat `msg_wait` as a substitute for doing the assigned work.",
  ].join("\n");
}

function buildIncrementalInstruction(input: {
  participantRole: CliMeetingParticipantRole;
  participantName: string;
  administrator: ThreadAdministratorInfo;
  messageCount: number;
}): string {
  const { participantRole, participantName, administrator, messageCount } = input;
  const messageWord = messageCount === 1 ? "message" : "messages";
  if (participantRole === "administrator") {
    return `${participantName}, you are the administrator for this thread and you have ${messageCount} new ${messageWord}. Review only the newly delivered messages and respond with the next coordinated step.`;
  }
  if (administrator.name) {
    return `${participantName}, you are a participant in this thread and the administrator is ${administrator.name}. You have ${messageCount} new ${messageWord}. Review only the newly delivered messages, respond only to the new context, and cooperate with the administrator's coordination.`;
  }
  return `${participantName}, you are a participant in this thread and you have ${messageCount} new ${messageWord}. Review only the newly delivered messages and respond only to the new context.`;
}

function formatHistory(messages: MessageRecord[]): string {
  if (!messages.length) {
    return "(No messages yet)";
  }
  return messages.map((message) => {
    const author = String(message.author_name || message.author || "Unknown").trim() || "Unknown";
    const role = String(message.role || "user").trim() || "user";
    const content = String(message.content || "").trim() || "(empty message)";
    return `[seq ${message.seq}] ${author} (${role})\n${content}`;
  }).join("\n\n");
}

function isPlaceholderRelayMessage(message: MessageRecord): boolean {
  const content = String(message.content || "").trim();
  const relayMode = String(message.metadata?.cli_relay_mode || "").trim();
  return (
    relayMode === "participant_session"
    && (/^Working\.\.\.(?: \(\d+s\))?$/.test(content) || content === "Thinking...")
  );
}

function buildMachineContext(input: {
  threadId: string;
  topic: string;
  status: string;
  systemPrompt?: string;
  participantAgentId: string;
  participantName: string;
  participantRole: CliMeetingParticipantRole;
  administrator: ThreadAdministratorInfo;
  deliveryMode: CliMeetingDeliveryMode;
  deliveredSeq: number;
  history: MessageRecord[];
  initialInstruction: string;
}): string {
  return JSON.stringify({
    type: "agentchatbus_cli_context_v1",
    thread: {
      id: input.threadId,
      topic: input.topic,
      status: input.status,
      latest_seq: input.deliveredSeq,
      system_prompt: input.systemPrompt || null,
    },
    participant: {
      agent_id: input.participantAgentId,
      display_name: input.participantName,
      role: input.participantRole,
    },
    administrator: {
      agent_id: input.administrator.agentId || null,
      name: input.administrator.name || null,
    },
    delivery: {
      mode: input.deliveryMode,
      latest_seq: input.deliveredSeq,
    },
    task: {
      instruction: input.initialInstruction,
    },
    messages: input.history.map((message) => ({
      seq: message.seq,
      author: message.author_name || message.author,
      role: message.role,
      content: message.content,
      created_at: message.created_at,
    })),
  }, null, 2);
}

export function buildCliMeetingPrompt(input: BuildCliMeetingPromptInput): CliMeetingPromptEnvelope {
  const thread = input.store.getThread(input.threadId);
  if (!thread) {
    throw new Error(`Thread '${input.threadId}' not found.`);
  }
  const participant = input.store.getAgent(input.participantAgentId);
  if (!participant) {
    throw new Error(`Participant agent '${input.participantAgentId}' not found.`);
  }

  const projectedMessages = input.store.projectMessagesForAgent(
    input.store.getMessages(input.threadId, 0, true),
  );
  const deliveredSeq = input.store.getThreadCurrentSeq(input.threadId);
  const participantName = String(input.participantDisplayName || getAgentDisplayName(participant)).trim();
  const deliveryMode = input.deliveryMode || "join";
  const administrator = getThreadAdministratorInfo(input.store, input.threadId);
  const multiParticipantMode = input.store.getThreadAgents(input.threadId).length > 1;
  const initialInstruction = String(input.initialInstruction || "").trim() || buildDefaultInstruction({
    participantRole: input.participantRole,
    hasHistory: projectedMessages.length > 0,
    administrator,
    participantName,
  });
  const meetingControlInstructions = buildMeetingControlInstructions({
    participantAgentId: input.participantAgentId,
    participantName,
    multiParticipantMode,
  });
  const adminLabel = administrator.name || administrator.agentId || "Unassigned";
  const roleLabel = input.participantRole === "administrator" ? "administrator" : "participant";
  const machineContext = buildMachineContext({
    threadId: thread.id,
    topic: thread.topic,
    status: thread.status,
    systemPrompt: thread.system_prompt,
    participantAgentId: input.participantAgentId,
    participantName,
    participantRole: input.participantRole,
    administrator,
    deliveryMode,
    deliveredSeq,
    history: projectedMessages,
    initialInstruction,
  });

  const prompt = [
    `You are participating in the AgentChatBus thread "${thread.topic}".`,
    `Thread ID: ${thread.id}`,
    `If you must refer to the thread explicitly, use thread_name "${thread.topic}" or thread_id "${thread.id}".`,
    `Thread status: ${thread.status}`,
    `Your participant identity: ${participantName} (${input.participantAgentId})`,
    `Your current role: ${roleLabel}`,
    `Current administrator: ${adminLabel}`,
    input.participantRole === "administrator"
      ? "You have been selected as the administrator for this thread. You are responsible for coordination and task assignment."
      : administrator.name
        ? `You are a participant in this thread. The administrator is ${administrator.name}. Please cooperate with the administrator's coordination.`
        : "You are a participant in this thread. Cooperate with the thread administrator when one is assigned.",
    deliveryMode === "join"
      ? "This is your first delivery into this thread."
      : `This is a ${deliveryMode} delivery.`,
    buildCodingAutonomyInstructions({
      participantRole: input.participantRole,
      administrator,
    }),
    "Visible thread history follows. The synthetic system prompt, if present, is included as seq 0. If any content is marked as hidden, do not speculate about the hidden parts.",
    formatHistory(projectedMessages),
    `Current instruction:\n${initialInstruction}`,
    meetingControlInstructions,
    "Write only the message content that AgentChatBus should post to the thread on your behalf. Do not emit JSON wrappers, XML tags, terminal commentary, or tool-call narration.",
    "Machine-readable context:",
    "```json",
    machineContext,
    "```",
  ].filter(Boolean).join("\n\n");

  return {
    prompt,
    deliveredSeq,
    deliveryMode,
    administrator,
  };
}

export function buildCliIncrementalPrompt(input: BuildCliIncrementalPromptInput): CliMeetingPromptEnvelope {
  const thread = input.store.getThread(input.threadId);
  if (!thread) {
    throw new Error(`Thread '${input.threadId}' not found.`);
  }
  const participant = input.store.getAgent(input.participantAgentId);
  if (!participant) {
    throw new Error(`Participant agent '${input.participantAgentId}' not found.`);
  }

  const participantName = String(input.participantDisplayName || getAgentDisplayName(participant)).trim();
  const administrator = getThreadAdministratorInfo(input.store, input.threadId);
  const multiParticipantMode = input.store.getThreadAgents(input.threadId).length > 1;
  const targetSeq = Number.isFinite(Number(input.targetSeq))
    ? Number(input.targetSeq)
    : input.store.getThreadCurrentSeq(input.threadId);
  const afterSeq = Math.max(0, Number(input.lastDeliveredSeq) || 0);
  const projectedMessages = input.store.projectMessagesForAgent(
    input.store
      .getMessages(input.threadId, afterSeq, false)
      .filter((message) => message.seq <= targetSeq)
      .filter((message) => !isPlaceholderRelayMessage(message)),
  );
  const deliveryMessages = projectedMessages.filter(
    (message) => String(message.author_id || "") !== input.participantAgentId,
  );
  const deliveredSeq = projectedMessages.length > 0
    ? projectedMessages[projectedMessages.length - 1]!.seq
    : afterSeq;
  const initialInstruction = buildIncrementalInstruction({
    participantRole: input.participantRole,
    participantName,
    administrator,
    messageCount: deliveryMessages.length,
  });
  const meetingControlInstructions = buildMeetingControlInstructions({
    participantAgentId: input.participantAgentId,
    participantName,
    multiParticipantMode,
  });
  const adminLabel = administrator.name || administrator.agentId || "Unassigned";
  const roleLabel = input.participantRole === "administrator" ? "administrator" : "participant";
  const prompt = [
    `You are continuing participation in the AgentChatBus thread "${thread.topic}".`,
    `Thread ID: ${thread.id}`,
    `If you must refer to the thread explicitly, use thread_name "${thread.topic}" or thread_id "${thread.id}".`,
    `Thread status: ${thread.status}`,
    `Your participant identity: ${participantName} (${input.participantAgentId})`,
    `Your current role: ${roleLabel}`,
    `Current administrator: ${adminLabel}`,
    input.participantRole === "administrator"
      ? "You are the administrator for this thread. Continue coordinating the discussion and next steps."
      : administrator.name
        ? `You are a participant in this thread. The administrator is ${administrator.name}. Continue cooperating with the administrator's coordination.`
        : "You are a participant in this thread. Continue cooperating with the thread administrator when one is assigned.",
    buildCodingAutonomyInstructions({
      participantRole: input.participantRole,
      administrator,
    }),
    `This is an incremental delivery of messages with seq > ${afterSeq} and <= ${targetSeq}.`,
    "Only the newly delivered visible messages are shown below.",
    "Respond only to the newly delivered context. Do not repeat your earlier introduction or restate old context unless the new messages require it.",
    formatHistory(deliveryMessages),
    `Current instruction:\n${initialInstruction}`,
    meetingControlInstructions,
    "Write only the message content that AgentChatBus should post to the thread on your behalf.",
    "Do not emit JSON wrappers, XML tags, terminal commentary, tool-call narration, or repeated summaries of older messages.",
  ].filter(Boolean).join("\n\n");

  return {
    prompt,
    deliveredSeq,
    deliveryMode: "incremental",
    administrator,
  };
}

export function buildCliMcpMeetingPrompt(input: BuildCliMcpMeetingPromptInput): CliMeetingPromptEnvelope {
  const thread = input.store.getThread(input.threadId);
  if (!thread) {
    throw new Error(`Thread '${input.threadId}' not found.`);
  }
  const participant = input.store.getAgent(input.participantAgentId);
  if (!participant) {
    throw new Error(`Participant agent '${input.participantAgentId}' not found.`);
  }
  const participantToken = String(participant.token || "").trim();
  if (!participantToken) {
    throw new Error(`Participant agent '${input.participantAgentId}' does not have a resumable token.`);
  }

  const participantName = String(input.participantDisplayName || getAgentDisplayName(participant)).trim();
  const deliveredSeq = input.store.getThreadCurrentSeq(input.threadId);
  const administrator = getThreadAdministratorInfo(input.store, input.threadId);
  const initialInstruction = String(input.initialInstruction || "").trim() || buildDefaultMcpInstruction({
    participantName,
    hasHistory: deliveredSeq > 0,
  });
  const prompt = renderCliMcpMeetingPrompt({
    threadId: thread.id,
    threadTopic: thread.topic,
    participantAgentId: input.participantAgentId,
    participantToken,
    participantName,
    participantRole: input.participantRole,
    administrator,
    initialInstruction,
    adapter: input.adapter,
    mode: input.mode,
  });

  return {
    prompt,
    deliveredSeq,
    deliveryMode: "join",
    administrator,
  };
}

export function buildCliMcpMeetingPromptPreview(
  input: BuildCliMcpMeetingPromptPreviewInput,
): CliMeetingPromptPreviewEnvelope {
  const thread = input.threadId ? input.store.getThread(input.threadId) : undefined;
  const threadIdResolved = Boolean(thread?.id || input.threadId);
  const threadNameResolved = Boolean(thread?.topic || input.topic);
  const participantAgentId = String(input.participantAgentId || "").trim();
  const participantToken = String(input.participantToken || "").trim();
  const threadId = String(
    thread?.id
    || input.threadId
    || "<thread_id will be created at launch>",
  ).trim() || "<thread_id will be created at launch>";
  const threadTopic = String(
    thread?.topic
    || input.topic
    || "current thread",
  ).trim() || "current thread";
  const participantName = String(input.participantDisplayName || "Agent").trim() || "Agent";
  const deliveredSeq = thread ? input.store.getThreadCurrentSeq(thread.id) : 0;
  const administrator = thread
    ? getThreadAdministratorInfo(input.store, thread.id)
    : {
        agentId: String(input.administratorAgentId || "").trim() || undefined,
        name: String(input.administratorName || "").trim() || undefined,
      };
  const initialInstruction = String(input.initialInstruction || "").trim() || buildDefaultMcpInstruction({
    participantName,
    hasHistory: deliveredSeq > 0,
  });
  const prompt = renderCliMcpMeetingPrompt({
    threadId,
    threadTopic,
    participantAgentId: participantAgentId
      || "<agent_id will be registered at launch>",
    participantToken: participantToken
      || "<token will be issued at launch>",
    participantName,
    participantRole: input.participantRole,
    administrator,
    initialInstruction,
    adapter: input.adapter,
    mode: input.mode,
  });
  const participantIdentityResolved = Boolean(participantAgentId && participantToken);
  const administratorResolved = Boolean(administrator.agentId || administrator.name);
  return {
    prompt,
    deliveredSeq,
    deliveryMode: "join",
    administrator,
    resolution: {
      threadIdResolved,
      participantIdentityResolved,
      administratorResolved,
      exactLaunchPrompt: threadNameResolved && participantIdentityResolved,
    },
  };
}
