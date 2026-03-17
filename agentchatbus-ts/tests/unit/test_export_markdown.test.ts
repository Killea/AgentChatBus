/**
 * Export Markdown Tests
 * Ported from Python: tests/test_export_markdown.py
 * 
 * Tests for the thread Markdown export endpoint.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Export Markdown', () => {
  let store: MemoryStore;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ':memory:';
    store = new MemoryStore();
    store.reset();
  });

  function postMessage(threadId: string, author: string, content: string) {
    const sync = store.issueSyncContext(threadId);
    return store.postMessage({
      threadId,
      author,
      content,
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
    });
  }

  it('export returns null for non-existent thread', () => {
    const md = store.exportThreadMarkdown('non-existent-id');
    expect(md).toBeNull();
  });

  it('export with messages produces valid markdown structure', () => {
    const { thread } = store.createThread('Export-Test');
    
    postMessage(thread.id, 'agent-1', 'First message content');
    postMessage(thread.id, 'agent-2', 'Second message content');
    postMessage(thread.id, 'agent-3', 'Third message content');

    const md = store.exportThreadMarkdown(thread.id);
    
    expect(md).not.toBeNull();
    expect(md).toContain('# Export-Test');
    expect(md).toContain('**Status:** discuss');
    expect(md).toContain('**Messages:** 3');
    expect(md).toContain('### agent-1');
    expect(md).toContain('First message content');
    expect(md).toContain('### agent-2');
    expect(md).toContain('Second message content');
    expect(md).toContain('### agent-3');
    expect(md).toContain('Third message content');
  });

  it('export empty thread produces header only', () => {
    const { thread } = store.createThread('Empty-Thread');
    
    const md = store.exportThreadMarkdown(thread.id);
    
    expect(md).not.toBeNull();
    expect(md).toContain('# Empty-Thread');
    expect(md).toContain('**Messages:** 0');
    // Should not contain any message sections
    expect(md).not.toContain('### ');
  });

  it('export excludes system prompt messages', () => {
    const { thread } = store.createThread('System-Prompt-Test', 'Custom prompt here');
    
    // Get messages with system prompt to verify it would be included
    const msgsWithSys = store.getMessages(thread.id, 0, true);
    expect(msgsWithSys.length).toBeGreaterThan(0);
    expect(msgsWithSys[0].role).toBe('system');
    
    // Export should NOT include system prompt
    const md = store.exportThreadMarkdown(thread.id);
    expect(md).not.toBeNull();
    expect(md).not.toContain('SYSTEM DIRECTIVE');
    expect(md).not.toContain('Custom prompt here');
    expect(md).toContain('**Messages:** 0');
  });

  it('export includes thread status', () => {
    const { thread } = store.createThread('Status-Test');
    postMessage(thread.id, 'user', 'Hello');
    
    // Change status
    store.setThreadStatus(thread.id, 'implement');
    
    const md = store.exportThreadMarkdown(thread.id);
    expect(md).toContain('**Status:** implement');
  });

  it('export uses author_name when available', () => {
    const { thread } = store.createThread('Author-Name-Test');
    
    // Register agent - name is auto-generated as "{ide} ({model})"
    const agent = store.registerAgent({
      ide: 'VS Code',
      model: 'GPT-4',
    });
    
    // Post message with agent as author
    const sync = store.issueSyncContext(thread.id, agent.id);
    store.postMessage({
      threadId: thread.id,
      author: agent.id,
      content: 'Agent message',
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
    });
    
    const md = store.exportThreadMarkdown(thread.id);
    // Should use agent name as author_name in export
    expect(md).toContain('### VS Code (GPT-4)');
  });

  it('export format includes proper separators', () => {
    const { thread } = store.createThread('Separator-Test');
    postMessage(thread.id, 'user-a', 'Message A');
    postMessage(thread.id, 'user-b', 'Message B');
    
    const md = store.exportThreadMarkdown(thread.id);
    
    // Should have separators between messages
    const separatorCount = (md?.match(/---/g) || []).length;
    expect(separatorCount).toBeGreaterThanOrEqual(3); // Initial + per message
  });
});
