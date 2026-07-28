import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../web-ui/js/components/acb-modal-shell.js";
import "../../../web-ui/js/shared-modals.js";

const THREAD_ID = "thread-abc-123";

function getOverlay() {
  return document.getElementById("thread-settings-modal-overlay");
}

function createThreadSettingsApi(overrides = {}) {
  const agents = overrides.agents ?? [
    { id: "agent-1", emoji: "🦊" },
  ];
  const settings = overrides.settings ?? {
    timeout_seconds: 90,
    switch_timeout_seconds: 120,
  };
  const admin = overrides.admin ?? {
    admin_id: "agent-1",
    admin_name: "Coordinator",
    admin_type: "creator",
  };
  const saveResponse = overrides.saveResponse ?? { ok: true };

  return vi.fn(async (path, options) => {
    if (path === "/api/agents") {
      return agents;
    }
    if (path === `/api/threads/${THREAD_ID}/settings` && !options?.method) {
      return settings;
    }
    if (path === `/api/threads/${THREAD_ID}/admin`) {
      return admin;
    }
    if (path === `/api/threads/${THREAD_ID}/settings` && options?.method === "POST") {
      if (typeof overrides.saveResponse === "function") {
        return overrides.saveResponse(path, options);
      }
      return saveResponse;
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}

describe("thread settings modal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    const shell = document.createElement("acb-modal-shell");
    document.body.appendChild(shell);
    window.currentThreadId = THREAD_ID;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    delete window.currentThreadId;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not open when currentThreadId is missing", async () => {
    delete window.currentThreadId;
    const api = createThreadSettingsApi();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await window.AcbModals.openThreadSettingsModal(api);

    expect(api).not.toHaveBeenCalled();
    expect(getOverlay().style.display).toBe("none");
    expect(errorSpy).toHaveBeenCalledWith("No current thread selected");
  });

  it("does not submit when currentThreadId is missing", async () => {
    delete window.currentThreadId;
    const api = createThreadSettingsApi();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await window.AcbModals.submitThreadSettings(api);

    expect(api).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("No current thread selected");
  });

  it("open populates timeout fields and current admin from API", async () => {
    const api = createThreadSettingsApi();

    await window.AcbModals.openThreadSettingsModal(api);

    expect(getOverlay().style.display).toBe("flex");
    expect(document.getElementById("ts-timeout-seconds").value).toBe("90");
    expect(document.getElementById("ts-switch-timeout-seconds").value).toBe("120");
    expect(document.getElementById("ts-current-admin").textContent).toBe(
      "🦊 Coordinator (Creator)"
    );
    expect(document.getElementById("thread-settings-message").style.display).toBe("none");

    expect(api).toHaveBeenCalledWith("/api/agents");
    expect(api).toHaveBeenCalledWith(`/api/threads/${THREAD_ID}/settings`);
    expect(api).toHaveBeenCalledWith(`/api/threads/${THREAD_ID}/admin`);
  });

  it("closeThreadSettingsModal hides the overlay", async () => {
    const api = createThreadSettingsApi();
    await window.AcbModals.openThreadSettingsModal(api);
    expect(getOverlay().style.display).toBe("flex");

    window.AcbModals.closeThreadSettingsModal();

    expect(getOverlay().style.display).toBe("none");
  });

  it("closeThreadSettingsModal ignores clicks that are not on the overlay", async () => {
    const api = createThreadSettingsApi();
    await window.AcbModals.openThreadSettingsModal(api);

    const innerModal = document.getElementById("thread-settings-modal");
    window.AcbModals.closeThreadSettingsModal({ target: innerModal });

    expect(getOverlay().style.display).toBe("flex");
  });

  it("submit success shows success message and auto-closes the modal", async () => {
    vi.useFakeTimers();
    const api = createThreadSettingsApi();
    await window.AcbModals.openThreadSettingsModal(api);

    document.getElementById("ts-timeout-seconds").value = "45";
    document.getElementById("ts-switch-timeout-seconds").value = "75";

    const submitPromise = window.AcbModals.submitThreadSettings(api);
    await submitPromise;

    const msg = document.getElementById("thread-settings-message");
    expect(msg.textContent).toBe("Settings saved successfully!");
    expect(msg.style.display).toBe("block");
    expect(msg.style.color).toBe("var(--green)");
    expect(getOverlay().style.display).toBe("flex");

    const postCall = api.mock.calls.find(
      ([path, options]) =>
        path === `/api/threads/${THREAD_ID}/settings` && options?.method === "POST"
    );
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(postCall[1].body);
    expect(payload.timeout_seconds).toBe(45);
    expect(payload.switch_timeout_seconds).toBe(75);
    expect(payload.auto_administrator_enabled).toBe(true);
    expect(payload.auto_coordinator_enabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1500);
    expect(getOverlay().style.display).toBe("none");
  });

  it("submit error with detail keeps modal open and shows error message", async () => {
    const api = createThreadSettingsApi({
      saveResponse: { detail: "Invalid timeout value" },
    });
    await window.AcbModals.openThreadSettingsModal(api);

    await window.AcbModals.submitThreadSettings(api);

    const msg = document.getElementById("thread-settings-message");
    expect(msg.textContent).toBe("Invalid timeout value");
    expect(msg.style.display).toBe("block");
    expect(msg.style.color).toBe("var(--red, #f05555)");
    expect(getOverlay().style.display).toBe("flex");
  });

  it("submit rejection shows generic error and keeps modal open", async () => {
    const api = createThreadSettingsApi({
      saveResponse: () => {
        throw new Error("Network failure");
      },
    });
    await window.AcbModals.openThreadSettingsModal(api);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await window.AcbModals.submitThreadSettings(api);

    const msg = document.getElementById("thread-settings-message");
    expect(msg.textContent).toBe("Error saving settings");
    expect(msg.style.display).toBe("block");
    expect(msg.style.color).toBe("var(--red, #f05555)");
    expect(getOverlay().style.display).toBe("flex");
  });
});
