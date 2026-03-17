export type ThreadStatus = "discuss" | "implement" | "review" | "done" | "closed" | "archived";

export interface AgentRecord {
  id: string;
  name: string;
  display_name?: string;
  ide?: string;
  model?: string;
  description?: string;
  is_online: boolean;
  last_heartbeat: string;
  last_activity?: string;
  last_activity_time?: string;
  capabilities?: string[];
  skills?: unknown[];
  // Token is optional - not exposed in listAgents for security (Python parity)
  token?: string;
  emoji?: string;
  // 移植自：Python test_agent_registry.py L39
  // alias_source 用于追踪 display_name 的来源 ('user' | 'auto')
  alias_source?: string;
}

export interface ThreadRecord {
  id: string;
  topic: string;
  status: ThreadStatus;
  created_at: string;
  system_prompt?: string;
  template_id?: string;
  waiting_agents?: Array<{ id: string; display_name?: string; emoji?: string }>;
}

export interface MessageRecord {
  id: string;
  thread_id: string;
  seq: number;
  priority: string;
  author: string;
  author_id?: string;
  author_name?: string;
  author_emoji?: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;
  reactions?: Array<{ agent_id: string; reaction: string }>;
  edited_at?: string | null;
  edit_version?: number;
  reply_to_msg_id?: string;
  created_at: string;
}

export interface SyncContext {
  current_seq: number;
  reply_token: string;
  reply_window: {
    expires_at: number;
    max_new_messages: number;
  };
}

export interface IdeSessionState {
  instance_id?: string | null;
  session_token?: string | null;
  registered?: boolean;
  ownership_assignable?: boolean;
  owner_instance_id?: string | null;
  owner_ide_label?: string | null;
  is_owner?: boolean;
  can_shutdown?: boolean;
  registered_sessions_count?: number;
  shutdown_requested?: boolean;
  transferred_to?: string | null;
  was_owner?: boolean;
}