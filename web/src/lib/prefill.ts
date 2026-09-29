// Hand text to a composer that may not be mounted yet (e.g. starting a check-in switches tabs first).
const pending = new Map<string, string>();

export function prefillComposer(target: string, text: string): void {
  pending.set(target, text);
  window.dispatchEvent(new CustomEvent('theologians:prefill', { detail: { target, text } }));
}

export function takePrefill(target: string | undefined): string | null {
  if (!target) return null;
  const text = pending.get(target) ?? null;
  pending.delete(target);
  return text;
}
