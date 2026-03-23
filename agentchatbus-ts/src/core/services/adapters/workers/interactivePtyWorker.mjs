let terminal = null;
let stdout = "";
let stderr = "";
let settled = false;

function send(message) {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  send({ type: "error", message });
}

function finalize(exitCode) {
  if (settled) {
    return;
  }
  settled = true;
  send({
    type: "exit",
    exitCode: typeof exitCode === "number" ? exitCode : null,
    stdout,
    stderr,
  });
}

async function start(payload) {
  if (process.platform !== "win32") {
    throw new Error("Interactive PTY worker currently requires Windows PowerShell.");
  }

  const nodePty = await import("node-pty").catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Interactive PTY sessions require the optional 'node-pty' runtime. ` +
      `Rebuild the bundled server resources so 'resources/bundled-server/node_modules' is present. ` +
      `Original error: ${detail}`,
    );
  });

  terminal = nodePty.spawn(payload.shellCommand, payload.shellArgs, {
    name: "xterm-256color",
    cwd: payload.cwd,
    env: payload.env,
    cols: payload.cols,
    rows: payload.rows,
    useConpty: Boolean(payload.useConpty),
  });

  if (typeof terminal.pid === "number" && terminal.pid > 0) {
    send({ type: "process-start", pid: terminal.pid });
  }

  terminal.onData((data) => {
    stdout += data;
    send({ type: "output", stream: "stdout", text: data });
  });

  terminal.onExit(({ exitCode }) => {
    finalize(exitCode);
    process.exit(0);
  });
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object" || !message.type) {
    return;
  }
  try {
    switch (message.type) {
      case "start":
        await start(message.payload);
        return;
      case "write":
        terminal?.write(String(message.text || ""));
        return;
      case "resize":
        terminal?.resize(Number(message.cols) || 120, Number(message.rows) || 40);
        return;
      case "kill":
        try {
          terminal?.kill();
        } catch (error) {
          stderr += error instanceof Error ? error.message : String(error);
        }
        return;
      default:
        return;
    }
  } catch (error) {
    fail(error);
  }
});

process.on("uncaughtException", (error) => {
  stderr += error instanceof Error ? `${error.stack || error.message}\n` : `${String(error)}\n`;
  fail(error);
});

process.on("unhandledRejection", (error) => {
  stderr += error instanceof Error ? `${error.stack || error.message}\n` : `${String(error)}\n`;
  fail(error);
});

send({ type: "ready" });
