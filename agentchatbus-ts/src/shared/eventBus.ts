type Listener = (event: Record<string, unknown>) => void;

class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
      }
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

export const eventBus = new EventBus();