import type { JobEvent } from './types.js';

type Listener = (event: JobEvent) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(jobId: string, listener: Listener): () => void {
    const set = this.listeners.get(jobId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(jobId, set);
    return () => set.delete(listener);
  }

  publish(event: JobEvent): void {
    for (const listener of this.listeners.get(event.jobId) ?? []) listener(event);
  }
}
