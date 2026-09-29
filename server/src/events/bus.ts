import type { AppEvent, AppEventEnvelope } from '../../../shared/types.ts';

type Listener = (event: AppEventEnvelope) => void;

/**
 * In-process publish/subscribe. Every open view (desktop window or browser tab) holds one SSE
 * subscription, so a change made in one view shows up in all of them.
 */
export class EventBus {
  readonly #listeners = new Set<Listener>();

  publish(event: AppEvent, originClientId?: string): void {
    const envelope: AppEventEnvelope = originClientId ? { ...event, originClientId } : event;
    for (const listener of [...this.#listeners]) {
      try {
        listener(envelope);
      } catch {
        // A broken subscriber must never break the publisher.
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }
}
