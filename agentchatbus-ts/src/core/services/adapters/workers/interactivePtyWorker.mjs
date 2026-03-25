import process from "node:process";

let ptyModulePromise = null;
let terminal = null;
let settled = false;
let stdout = "";
let stderr = "";

function send(message) {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

function normalizeCols(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 160;
  }
  return Math.min(Math.max(Math.floor(numeric), 40), 320);
}

function normalizeRows(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 48;
  }
  return Math.min(Math.max(Math.floor(numeric), 10), 120);
}

async function loadNodePty() {
  if (!ptyModulePromise) {
    ptyModulePromise = import("node-pty").catch((error) => {
      ptyModulePromise = null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        "Interactive PTY sessions require the optional 'node-pty' runtime. " +
        "Rebuild the bundled server resources so 'resources/bundled-server/node_modules' is present. " +
        `Original error: ${detail}`,
      );
    });
  }
  return await ptyModulePromise;
}

function finalize(exitCode) {
  if (settled) {
    return;
  }
  settled = true;
  send({
    type: "exit",
    exitCode,
    stdout,
    stderr,
  });
}

function fail(error) {
  if (settled) {
    return;
  }
  settled = true;
  send({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}

function killTerminal() {
  if (!terminal) {
    return;
  }
  try {
    terminal.kill();
  } catch {
    // Best effort shutdown.
  }
}

async function startWorker(payload) {
  const nodePty = await loadNodePty();

  terminal = nodePty.spawn(payload.shellCommand, payload.shellArgs, {
    name: "xterm-256color",
    cwd: payload.cwd,
    env: payload.env,
    cols: normalizeCols(payload.cols),
    rows: normalizeRows(payload.rows),
    useConpty: payload.useConpty !== false,
  });

  if (typeof terminal.pid === "number" && terminal.pid > 0) {
    send({
      type: "process-start",
      pid: terminal.pid,
    });
  }

  terminal.onData((data) => {
    stdout += data;
    send({
      type: "output",
      stream: "stdout",
      text: data,
    });
  });

  if (typeof terminal.onBinary === "function") {
    terminal.onBinary((data) => {
      stdout += data;
      send({
        type: "output",
        stream: "stdout",
        text: data,
      });
    });
  }

  terminal.onExit(({ exitCode }) => {
    terminal = null;
    finalize(exitCode);
  });
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object" || !("type" in message)) {
    return;
  }

  try {
    switch (message.type) {
      case "start":
        await startWorker(message.payload);
        return;
      case "write":
        terminal?.write(String(message.text || ""));
        return;
      case "resize":
        if (terminal && typeof terminal.resize === "function") {
          terminal.resize(normalizeCols(message.cols), normalizeRows(message.rows));
        }
        return;
      case "kill":
        killTerminal();
        return;
      default:
        return;
    }
  } catch (error) {
    fail(error);
  }
});

process.on("uncaughtException", (error) => {
  fail(error);
});

process.on("unhandledRejection", (error) => {
  fail(error);
});

process.on("disconnect", () => {
  killTerminal();
  if (!settled) {
    finalize(null);
  }
});

send({ type: "ready" });
