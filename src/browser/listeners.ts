interface Message<T = string> {
  type: T;
}

export class Listeners<M extends Message> {
  private listenersByType = new Map<M["type"], Set<(msg: M) => void>>();

  addListener(type: M["type"], listener: (msg: M) => void) {
    const listeners =
      this.listenersByType.get(type) ??
      (() => {
        const listeners = new Set<(msg: M) => void>();
        this.listenersByType.set(type, listeners);
        return listeners;
      })();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  trigger(msg: M) {
    this.listenersByType.get(msg.type)?.forEach((listener) => listener(msg));
  }
}
