import type { SendMessagePayload, SyncContext } from '../api/types';

export type SendMessageRequestBody = {
    author: string;
    content: string;
    mentions?: string[];
    metadata?: Record<string, unknown>;
    images?: Array<{ url: string; name?: string }>;
    reply_to_msg_id?: string;
    expected_last_seq?: number;
    reply_token?: string;
};

export function normalizeSendMessagePayload(payload: string | SendMessagePayload): SendMessagePayload {
    return typeof payload === 'string'
        ? { content: payload }
        : payload;
}

export function buildSendMessageRequestBody(
    payload: string | SendMessagePayload,
    syncContext: SyncContext
): SendMessageRequestBody {
    const normalizedPayload = normalizeSendMessagePayload(payload);
    return {
        author: normalizedPayload.author || 'human',
        content: normalizedPayload.content,
        mentions: normalizedPayload.mentions,
        metadata: normalizedPayload.metadata,
        images: normalizedPayload.images,
        reply_to_msg_id: normalizedPayload.reply_to_msg_id,
        expected_last_seq: syncContext.current_seq,
        reply_token: syncContext.reply_token
    };
}

export function shouldRetrySendMessage(status: number, errorPayload: unknown): boolean {
    if (status !== 409 || !errorPayload || typeof errorPayload !== 'object') {
        return false;
    }
    const maybe = errorPayload as { action?: unknown };
    return maybe.action === 'READ_MESSAGES_THEN_CALL_MSG_WAIT';
}
