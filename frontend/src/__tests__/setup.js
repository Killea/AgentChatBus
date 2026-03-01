// setup.js - Global test setup
export function mockEventSource() {
  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.readyState = 0; // CONNECTING
    }
    
    addEventListener(event, handler) {
      if (!this.listeners[event]) {
        this.listeners[event] = [];
      }
      this.listeners[event].push(handler);
    }
    
    removeEventListener(event, handler) {
      if (this.listeners[event]) {
        this.listeners[event] = this.listeners[event].filter(h => h !== handler);
      }
    }
    
    close() {
      this.readyState = 2; // CLOSED
    }
    
    _trigger(event, data) {
      if (this.listeners[event]) {
        this.listeners[event].forEach(handler => {
          handler({ data: JSON.stringify(data) });
        });
      }
    }
    
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
  }
  
  window.EventSource = MockEventSource;
  return MockEventSource;
}

// Set default mock
if (!window.EventSource) {
  mockEventSource();
}
