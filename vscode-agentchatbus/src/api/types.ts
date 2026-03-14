export interface Thread {
    id: string;
    topic: string;
    status: string;
    created_at: string;
    creator_admin_id?: string;
    auto_assigned_admin_id?: string;
    auto_administrator_enabled?: boolean;
}

export interface ThreadListResponse {
    threads: Thread[];
    total: number;
    has_more: boolean;
    next_cursor?: string | null;
}

export interface Message {
    id: string;
    thread_id: string;
    seq: number;
    priority: number;
    author?: string;
    author_id?: string;
    author_name?: string;
    author_emoji?: string;
    role?: string;
    reply_to_msg_id?: string;
    content: string;
    metadata?: any;
    reactions?: any[];
    created_at: string;
    edited_at?: string | null;
    edit_version?: number;
}

export interface Agent {
    id: string;
    name?: string;
    display_name?: string;
    ide?: string;
    model?: string;
    description?: string;
    emoji?: string;
    is_online: boolean;
    last_heartbeat: string;
    last_activity?: string;
    last_activity_time?: string;
    capabilities?: string[];
    skills?: any[];
    system_prompt?: string;
}

export interface SyncContext {
    current_seq: number;
    reply_token: string;
}

export interface SendMessagePayload {
    author?: string;
    content: string;
    mentions?: string[];
    metadata?: Record<string, unknown>;
    images?: Array<{ url: string; name?: string }>;
    reply_to_msg_id?: string;
}
