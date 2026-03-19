/**
 * Unit tests for SEC-06: Filesystem Disclosure Filter.
 *
 * Tests the pure detection logic, SHOW_AD gating, MemoryStore integration,
 * and the restricted_mode registration signal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  checkFilesystemDisclosure,
  checkFilesystemDisclosureOrThrow,
  isFilesystemDisclosureFilterActive,
  FilesystemDisclosureError,
} from "../../src/core/services/filesystemDisclosureFilter.js";
import { MemoryStore } from "../../src/core/services/memoryStore.js";

// ─── Pure detection tests ─────────────────────────────────────────────────────

describe("checkFilesystemDisclosure", () => {
  describe("allowed — non-disclosure content", () => {
    it("allows normal chat messages", () => {
      const { blocked } = checkFilesystemDisclosure("The refactor looks good, great work!");
      expect(blocked).toBe(false);
    });

    it("allows a single path mention in a sentence", () => {
      const { blocked } = checkFilesystemDisclosure(
        "Please check the file at C:\\Users\\me\\project\\src\\main.ts before merging."
      );
      expect(blocked).toBe(false);
    });

    it("allows a single Unix path mention", () => {
      const { blocked } = checkFilesystemDisclosure(
        "The config lives at /etc/nginx/nginx.conf — do not change the worker_processes line."
      );
      expect(blocked).toBe(false);
    });

    it("allows a casual mention of ~/.ssh/", () => {
      const { blocked } = checkFilesystemDisclosure(
        "Always protect your ~/.ssh/ directory and restrict permissions to 700."
      );
      expect(blocked).toBe(false);
    });

    it("allows code with 1-2 path references", () => {
      const { blocked } = checkFilesystemDisclosure(
        "```python\nwith open('/tmp/output.txt', 'w') as f:\n    f.write(result)\n```"
      );
      expect(blocked).toBe(false);
    });

    it("allows technical discussion about ls flags", () => {
      const { blocked } = checkFilesystemDisclosure(
        "Use `ls -la` to list hidden files. The total line shows disk block usage."
      );
      expect(blocked).toBe(false);
    });

    it("allows tree as a word without connector chars", () => {
      const { blocked } = checkFilesystemDisclosure(
        "The component tree looks clean. No circular dependencies detected."
      );
      expect(blocked).toBe(false);
    });
  });

  describe("blocked — Unix tree output", () => {
    it("blocks output with ├── connectors (2+ lines)", () => {
      const text = [
        "Here is the project structure:",
        "src/",
        "├── main.ts",
        "└── utils.ts",
      ].join("\n");
      const { blocked, reason } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(true);
      expect(reason).toMatch(/tree/i);
    });

    it("blocks deep tree output", () => {
      const text = [
        ".",
        "├── agentchatbus-ts",
        "│   ├── src",
        "│   │   └── main.ts",
        "└── README.md",
      ].join("\n");
      const { blocked } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(true);
    });
  });

  describe("blocked — Unix ls -la output", () => {
    it("blocks full ls -la output (total + permissions)", () => {
      const text = [
        "total 48",
        "drwxr-xr-x  5 user group 4096 Mar 19 10:00 .",
        "drwxr-xr-x 12 user group 4096 Mar 19 09:00 ..",
        "-rw-r--r--  1 user group  512 Mar 19 10:00 README.md",
      ].join("\n");
      const { blocked, reason } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(true);
      expect(reason).toMatch(/ls -la/i);
    });

    it("does not block permissions line without total header", () => {
      const text = "drwxr-xr-x  5 user group 4096 Mar 19 10:00 src";
      const { blocked } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(false);
    });
  });

  describe("blocked — Windows dir output", () => {
    it("blocks Windows dir listing with column header", () => {
      const text = [
        " Directory of C:\\Users\\user\\project",
        "",
        "Mode                 LastWriteTime         Length Name",
        "----                 -------------         ------ ----",
        "d----        19/03/2026     14:00                src",
        "-a---        19/03/2026     14:00          12345 README.md",
      ].join("\n");
      const { blocked, reason } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(true);
      expect(reason).toMatch(/Windows/i);
    });

    it("blocks PowerShell Get-ChildItem with 2+ mode lines", () => {
      const text = [
        "d----  03/19/2026  14:00  src",
        "-a---  03/19/2026  14:00  README.md",
        "-a---  03/19/2026  14:00  package.json",
      ].join("\n");
      const { blocked, reason } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(true);
      expect(reason).toMatch(/Windows/i);
    });
  });

  describe("blocked — dense path cluster", () => {
    it("blocks 3+ consecutive Unix absolute path lines", () => {
      const text = [
        "Here are all the config files:",
        "/etc/nginx/nginx.conf",
        "/etc/nginx/sites-enabled/default",
        "/etc/ssh/sshd_config",
      ].join("\n");
      const { blocked, reason } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(true);
      expect(reason).toMatch(/cluster/i);
    });

    it("blocks 3+ consecutive Windows absolute path lines", () => {
      const text = [
        "C:\\Windows\\System32\\drivers\\etc\\hosts",
        "C:\\Windows\\System32\\drivers\\etc\\services",
        "C:\\Users\\user\\AppData\\Local\\Temp\\file.tmp",
      ].join("\n");
      const { blocked, reason } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(true);
      expect(reason).toMatch(/cluster/i);
    });

    it("allows 2 consecutive path lines", () => {
      const text = [
        "Compare these two:",
        "/etc/nginx/nginx.conf",
        "/etc/apache2/apache2.conf",
      ].join("\n");
      const { blocked } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(false);
    });

    it("does not count non-consecutive paths", () => {
      const text = [
        "/etc/nginx/nginx.conf",
        "This file controls the server config.",
        "/etc/ssh/sshd_config",
        "This controls SSH.",
        "/etc/hosts",
      ].join("\n");
      const { blocked } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(false);
    });
  });

  describe("blocked — sensitive file content", () => {
    it("blocks /etc/passwd dump", () => {
      const text = [
        "root:x:0:0:root:/root:/bin/bash",
        "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
        "bin:x:2:2:bin:/bin:/usr/sbin/nologin",
      ].join("\n");
      const { blocked, reason } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(true);
      expect(reason).toMatch(/passwd/i);
    });

    it("blocks SSH public key dump", () => {
      const text = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC3... user@host";
      const { blocked, reason } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(true);
      expect(reason).toMatch(/SSH/i);
    });

    it("blocks ed25519 public key", () => {
      const text = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GkZXS user@host";
      const { blocked, reason } = checkFilesystemDisclosure(text);
      expect(blocked).toBe(true);
      expect(reason).toMatch(/SSH/i);
    });
  });
});

// ─── SHOW_AD gating tests ────────────────────────────────────────────────────

describe("isFilesystemDisclosureFilterActive", () => {
  const originalEnv = process.env.AGENTCHATBUS_SHOW_AD;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTCHATBUS_SHOW_AD;
    } else {
      process.env.AGENTCHATBUS_SHOW_AD = originalEnv;
    }
  });

  it("is inactive when SHOW_AD is not set", () => {
    delete process.env.AGENTCHATBUS_SHOW_AD;
    expect(isFilesystemDisclosureFilterActive()).toBe(false);
  });

  it("is active when SHOW_AD=true", () => {
    process.env.AGENTCHATBUS_SHOW_AD = "true";
    expect(isFilesystemDisclosureFilterActive()).toBe(true);
  });

  it("is active when SHOW_AD=1", () => {
    process.env.AGENTCHATBUS_SHOW_AD = "1";
    expect(isFilesystemDisclosureFilterActive()).toBe(true);
  });

  it("is active when SHOW_AD=yes", () => {
    process.env.AGENTCHATBUS_SHOW_AD = "yes";
    expect(isFilesystemDisclosureFilterActive()).toBe(true);
  });

  it("is inactive when SHOW_AD=false", () => {
    process.env.AGENTCHATBUS_SHOW_AD = "false";
    expect(isFilesystemDisclosureFilterActive()).toBe(false);
  });

  it("is inactive when SHOW_AD=0", () => {
    process.env.AGENTCHATBUS_SHOW_AD = "0";
    expect(isFilesystemDisclosureFilterActive()).toBe(false);
  });
});

describe("checkFilesystemDisclosureOrThrow", () => {
  afterEach(() => {
    delete process.env.AGENTCHATBUS_SHOW_AD;
  });

  it("throws FilesystemDisclosureError when SHOW_AD=true and disclosure detected", () => {
    process.env.AGENTCHATBUS_SHOW_AD = "true";
    const text = "├── src\n└── README.md";
    expect(() => checkFilesystemDisclosureOrThrow(text)).toThrow(FilesystemDisclosureError);
  });

  it("does not throw when SHOW_AD is not set, even for disclosure content", () => {
    delete process.env.AGENTCHATBUS_SHOW_AD;
    const text = "├── src\n└── README.md";
    expect(() => checkFilesystemDisclosureOrThrow(text)).not.toThrow();
  });

  it("does not throw when SHOW_AD=false, even for disclosure content", () => {
    process.env.AGENTCHATBUS_SHOW_AD = "false";
    const text = "├── src\n└── README.md";
    expect(() => checkFilesystemDisclosureOrThrow(text)).not.toThrow();
  });

  it("does not throw for normal content when SHOW_AD=true", () => {
    process.env.AGENTCHATBUS_SHOW_AD = "true";
    expect(() =>
      checkFilesystemDisclosureOrThrow("Great implementation, looks clean!")
    ).not.toThrow();
  });
});

describe("FilesystemDisclosureError", () => {
  it("has disclosureReason field", () => {
    const err = new FilesystemDisclosureError("Directory tree output");
    expect(err.disclosureReason).toBe("Directory tree output");
    expect(err.name).toBe("FilesystemDisclosureError");
    expect(err.message).toContain("demo mode");
    expect(err.message).toContain("Directory tree output");
  });
});

// ─── MemoryStore integration tests ───────────────────────────────────────────

describe("MemoryStore filesystem disclosure integration", () => {
  let store: MemoryStore;

  beforeEach(() => {
    process.env.AGENTCHATBUS_SHOW_AD = "true";
    process.env.AGENTCHATBUS_DB = ":memory:";
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
    delete process.env.AGENTCHATBUS_SHOW_AD;
    delete process.env.AGENTCHATBUS_DB;
  });

  it("postMessage blocks tree output when SHOW_AD=true", () => {
    const { thread } = store.createThread("test-thread");
    const sync = store.issueSyncContext(thread.id, "agent", "test");

    expect(() =>
      store.postMessage({
        threadId: thread.id,
        author: "agent",
        content: "src/\n├── main.ts\n└── utils.ts",
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
      })
    ).toThrow(FilesystemDisclosureError);
  });

  it("postMessage blocks ls -la output when SHOW_AD=true", () => {
    const { thread } = store.createThread("test-thread");
    const sync = store.issueSyncContext(thread.id, "agent", "test");

    const lsOutput = [
      "total 32",
      "drwxr-xr-x 4 user group 4096 Mar 19 10:00 .",
      "-rw-r--r-- 1 user group  512 Mar 19 10:00 README.md",
    ].join("\n");

    expect(() =>
      store.postMessage({
        threadId: thread.id,
        author: "agent",
        content: lsOutput,
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
      })
    ).toThrow(FilesystemDisclosureError);
  });

  it("postMessage allows normal messages when SHOW_AD=true", () => {
    const { thread } = store.createThread("test-thread");
    const sync = store.issueSyncContext(thread.id, "agent", "test");

    const msg = store.postMessage({
      threadId: thread.id,
      author: "agent",
      content: "The implementation looks correct. Ready for review.",
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
    });
    expect(msg.seq).toBeGreaterThan(0);
  });

  it("postMessage allows disclosure content when SHOW_AD=false (private instance)", () => {
    process.env.AGENTCHATBUS_SHOW_AD = "false";
    const localStore = new MemoryStore(":memory:");
    const { thread } = localStore.createThread("test-thread");
    const sync = localStore.issueSyncContext(thread.id, "agent", "test");

    const msg = localStore.postMessage({
      threadId: thread.id,
      author: "agent",
      content: "src/\n├── main.ts\n└── utils.ts",
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
    });
    expect(msg.seq).toBeGreaterThan(0);
    localStore.close();
  });

  it("editMessage blocks tree output when SHOW_AD=true", () => {
    const { thread } = store.createThread("test-thread");
    const sync = store.issueSyncContext(thread.id, "agent", "test");

    const msg = store.postMessage({
      threadId: thread.id,
      author: "agent",
      content: "Initial message content.",
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
    });

    expect(() =>
      store.editMessage(msg.id, "src/\n├── main.ts\n└── utils.ts", "agent")
    ).toThrow(FilesystemDisclosureError);
  });
});
