/**
 * Test script to verify image upload and message metadata flow.
 * Ported from Python: tests/test_image_flow.py
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';

describe('Image Flow Tests (Ported from Python)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    process.env.AGENTCHATBUS_DB = ':memory:';
    store = new MemoryStore();
    store.reset();
  });

  describe('Image metadata in messages', () => {
    it('message with image metadata stores correctly', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('image-test');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const testImages = [
        { url: '/static/uploads/test-image-1.jpg', name: 'test1.jpg' },
        { url: '/static/uploads/test-image-2.png', name: 'test2.png' }
      ];

      const message = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'Test message with images',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'user',
        metadata: {
          images: testImages,
          mentions: ['agent-1', 'agent-2']
        }
      });

      expect(message).toBeDefined();
      expect(message.metadata).toBeDefined();
    });

    it('retrieved message contains image metadata', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('image-retrieve-test');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const testImages = [
        { url: '/static/uploads/test-image-1.jpg', name: 'test1.jpg' },
        { url: '/static/uploads/test-image-2.png', name: 'test2.png' }
      ];

      store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'Test message with images',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'user',
        metadata: {
          images: testImages,
          mentions: ['agent-1', 'agent-2']
        }
      });

      const messages = store.getMessages(thread.id, 0);
      expect(messages.length).toBeGreaterThan(0);

      const msg = messages[0];
      expect(msg.metadata).toBeDefined();
      
      const metadata = typeof msg.metadata === 'string' 
        ? JSON.parse(msg.metadata) 
        : msg.metadata;
      
      expect(metadata.images).toBeDefined();
      expect(metadata.images.length).toBe(2);
      expect(metadata.images[0].url).toBe('/static/uploads/test-image-1.jpg');
      expect(metadata.images[1].url).toBe('/static/uploads/test-image-2.png');
      expect(metadata.mentions).toEqual(['agent-1', 'agent-2']);
    });

    it('message with single image stores correctly', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('single-image-test');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const message = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'Message with single image',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'user',
        metadata: {
          images: [{ url: '/static/uploads/single.jpg', name: 'single.jpg' }]
        }
      });

      expect(message).toBeDefined();
      
      const retrieved = store.getMessage(message.id);
      expect(retrieved).toBeDefined();
      
      if (retrieved) {
        const metadata = typeof retrieved.metadata === 'string'
          ? JSON.parse(retrieved.metadata)
          : retrieved.metadata;
        expect(metadata.images.length).toBe(1);
      }
    });

    it('message without images works normally', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('no-image-test');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const message = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'Plain text message',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'user'
      });

      expect(message).toBeDefined();
      expect(message.content).toBe('Plain text message');
    });

    it('multiple messages with different images in same thread', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('multi-image-thread');
      const sync1 = store.issueSyncContext(thread.id, agent.id, 'test');

      // First message with image
      const msg1 = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'First image',
        expectedLastSeq: sync1.current_seq,
        replyToken: sync1.reply_token,
        role: 'user',
        metadata: {
          images: [{ url: '/static/uploads/first.jpg', name: 'first.jpg' }]
        }
      });

      // Get new sync context
      const sync2 = store.issueSyncContext(thread.id, agent.id, 'test');

      // Second message with different image
      const msg2 = store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'Second image',
        expectedLastSeq: sync2.current_seq,
        replyToken: sync2.reply_token,
        role: 'user',
        metadata: {
          images: [{ url: '/static/uploads/second.png', name: 'second.png' }]
        }
      });

      expect(msg1.seq).toBe(1);
      expect(msg2.seq).toBe(2);

      const messages = store.getMessages(thread.id, 0);
      expect(messages.length).toBe(2);
    });
  });

  describe('Metadata preservation', () => {
    it('preserves all metadata fields', () => {
      const agent = store.registerAgent({ ide: 'VS Code', model: 'test' });
      const { thread } = store.createThread('metadata-preserve');
      const sync = store.issueSyncContext(thread.id, agent.id, 'test');

      const complexMetadata = {
        images: [
          { url: '/static/uploads/a.jpg', name: 'a.jpg' },
          { url: '/static/uploads/b.png', name: 'b.png' }
        ],
        mentions: ['agent-1', 'agent-2', 'agent-3'],
        customField: 'custom value',
        nestedObject: {
          level1: {
            level2: 'deep value'
          }
        },
        arrayField: [1, 2, 3, 'four']
      };

      store.postMessage({
        threadId: thread.id,
        author: agent.id,
        content: 'Complex metadata',
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
        role: 'user',
        metadata: complexMetadata
      });

      const messages = store.getMessages(thread.id, 0);
      const msg = messages[0];
      
      const metadata = typeof msg.metadata === 'string'
        ? JSON.parse(msg.metadata)
        : msg.metadata;

      expect(metadata.images).toBeDefined();
      expect(metadata.mentions).toEqual(['agent-1', 'agent-2', 'agent-3']);
      expect(metadata.customField).toBe('custom value');
      expect(metadata.nestedObject.level1.level2).toBe('deep value');
      expect(metadata.arrayField).toEqual([1, 2, 3, 'four']);
    });
  });
});
