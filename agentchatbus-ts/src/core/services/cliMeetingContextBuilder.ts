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
    return `${participantName}, please introduce yourself, explain how you can help, and start coordinating this thread.`;
  }
  if (participantRole === "administrator") {
    return `${participantName}, please review the thread history, introduce yourself briefly, and respond to the latest discussion with the next useful coordinated step.`;
  }
  if (hasHistory && administrator.name) {
    return `${participantName}, please introduce yourself briefly, then respond directly to the latest visible thread context. Follow coordination from ${administrator.name} when relevant.`;
  }
  return `${participantName}, please introduce yourself briefly and explain how you can contribute to this thread.`;
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
    return `${participantName}, you have ${messageCount} new ${messageWord}. Review only the newly delivered messages and respond with the next coordinated step.`;
  }
  if (administrator.name) {
    return `${participantName}, you have ${messageCount} new ${messageWord}. Review only the newly delivered messages and respond only to the new context, while respecting coordination from ${administrator.name}.`;
  }
  return `${participantName}, you have ${messageCount} new ${messageWord}. Review only the newly delivered messages and respond only to the new context.`;
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
    `Thread status: ${thread.status}`,
    `Your participant identity: ${participantName} (${input.participantAgentId})`,
    `Your current role: ${roleLabel}`,
    `Current administrator: ${adminLabel}`,
    deliveryMode === "join"
      ? "This is your first delivery into this thread."
      : `This is a ${deliveryMode} delivery.`,
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
    `Thread status: ${thread.status}`,
    `Your participant identity: ${participantName} (${input.participantAgentId})`,
    `Your current role: ${roleLabel}`,
    `Current administrator: ${adminLabel}`,
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
