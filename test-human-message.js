// Test script to verify human message storage
const { MemoryStore } = require('./agentchatbus-ts/dist/core/services/memoryStore.js');

const store = new MemoryStore(':memory:');

// Create a thread
const { thread } = store.createThread('Test Thread');
console.log('Created thread:', thread.id);

// Simulate posting a message as human (like the frontend does)
const sync = store.issueSyncContext(thread.id);
console.log('Sync context:', sync);

const message = store.postMessage({
  threadId: thread.id,
  author: 'human',  // Frontend sends 'human'
  content: 'Hello from human!',
  expectedLastSeq: sync.current_seq,
  replyToken: sync.reply_token,
  role: 'user'
});

console.log('\nPosted message:');
console.log('  id:', message.id);
console.log('  author:', message.author);
console.log('  author_id:', message.author_id);
console.log('  author_name:', message.author_name);
console.log('  author_emoji:', message.author_emoji);
console.log('  role:', message.role);
console.log('  content:', message.content);

// Now retrieve messages
const messages = store.getMessages(thread.id, 0);
console.log('\nRetrieved messages:');
messages.forEach((m, i) => {
  console.log(`  [${i}] author: ${m.author}, author_name: ${m.author_name}, author_id: ${m.author_id}, content: ${m.content}`);
});
