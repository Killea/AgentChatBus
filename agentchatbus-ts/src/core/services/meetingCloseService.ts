import type { MemoryStore } from "./memoryStore.js";

type ThreadSessionClearer = (threadId: string) => Promise<unknown[]>;

export type CloseMeetingResult =
  | {
      ok: true;
      thread_id: string;
      status: "closed";
      already_closed: boolean;
      closed_sessions_count: number;
    }
  | {
      ok: false;
      error: "THREAD_NOT_FOUND";
      detail: string;
    };

let activeThreadSessionClearer: ThreadSessionClearer | null = null;

export function registerThreadSessionClearer(clearer: ThreadSessionClearer): () => void {
  activeThreadSessionClearer = clearer;
  return () => {
    if (activeThreadSessionClearer === clearer) {
      activeThreadSessionClearer = null;
    }
  };
}

export function getThreadAdministratorIds(store: MemoryStore, threadId: string): string[] {
  const settings = store.getThreadSettings(threadId);
  return Array.from(
    new Set(
      [settings?.creator_admin_id, settings?.auto_assigned_admin_id]
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

export async function closeMeetingLikeHuman(
  store: MemoryStore,
  input: {
    threadId: string;
    summary?: string;
    closedBy?: {
      agentId: string;
      name: string;
    };
  },
): Promise<CloseMeetingResult> {
  const threadId = String(input.threadId || "").trim();
  const thread = store.getThread(threadId);
  if (!thread) {
    return {
      ok: false,
      error: "THREAD_NOT_FOUND",
      detail: `Thread '${threadId}' not found`,
    };
  }

  const alreadyClosed = String(thread.status || "").trim().toLowerCase() === "closed";
  const clearedSessions = activeThreadSessionClearer
    ? await activeThreadSessionClearer(threadId)
    : [];

  const ok = store.closeThread(threadId, input.summary);
  if (!ok) {
    return {
      ok: false,
      error: "THREAD_NOT_FOUND",
      detail: `Thread '${threadId}' not found`,
    };
  }

  if (!alreadyClosed && input.closedBy) {
    store.postSystemMessage(
      threadId,
      `This thread was closed by administrator ${input.closedBy.name} (${input.closedBy.agentId}) at ${new Date().toISOString()}.`,
      JSON.stringify({
        event: "meeting_closed",
        closed_by_agent_id: input.closedBy.agentId,
        closed_by_name: input.closedBy.name,
        closed_at: new Date().toISOString(),
      }),
      false,
    );
  }

  return {
    ok: true,
    thread_id: threadId,
    status: "closed",
    already_closed: alreadyClosed,
    closed_sessions_count: Array.isArray(clearedSessions) ? clearedSessions.length : 0,
  };
}
