import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AppEventEnvelope, ConversationDetailDto, MessageDto, MessagePart } from '../../../shared/types.ts';
import { clientId, sessionToken } from './client.ts';

export type LiveState = 'connecting' | 'open' | 'reconnecting';

type Listener = (event: AppEventEnvelope) => void;
const listeners = new Set<Listener>();

/** Subscribe to raw live events (for components that need more than cache invalidation). */
export function onLiveEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function textOf(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
}

function patchMessage(qc: QueryClient, conversationId: string, messageId: string, update: (m: MessageDto) => MessageDto | null): boolean {
  let applied = false;
  qc.setQueryData<ConversationDetailDto>(['conversation', conversationId], (detail) => {
    if (!detail) return detail;
    const index = detail.messages.findIndex((m) => m.id === messageId);
    if (index === -1) return detail;
    const next = update(detail.messages[index]!);
    if (!next) return detail;
    applied = true;
    const messages = [...detail.messages];
    messages[index] = next;
    return { ...detail, messages };
  });
  return applied;
}

function handle(qc: QueryClient, event: AppEventEnvelope): void {
  const fromMe = event.originClientId === clientId;
  switch (event.type) {
    case 'workspaces.changed':
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      break;
    case 'folders.changed':
      void qc.invalidateQueries({ queryKey: ['folders', event.workspaceId] });
      break;
    case 'conversations.changed':
      void qc.invalidateQueries({ queryKey: event.workspaceId ? ['conversations', event.workspaceId] : ['homeConversations'] });
      break;
    case 'conversation.updated':
      if (!fromMe) void qc.invalidateQueries({ queryKey: ['conversation', event.conversationId] });
      break;
    case 'draft.updated':
      if (event.conversationId && !fromMe) {
        qc.setQueryData<ConversationDetailDto>(['conversation', event.conversationId], (detail) =>
          detail ? { ...detail, conversation: { ...detail.conversation, draft: event.draft, draftAttachmentIds: event.attachmentIds } } : detail,
        );
      }
      break;
    case 'messages.changed':
    case 'approvals.changed':
      void qc.invalidateQueries({ queryKey: ['conversation', event.conversationId] });
      break;
    case 'message.delta': {
      let needsRefetch = false;
      const known = patchMessage(qc, event.conversationId, event.messageId, (m) => {
        const parts = [...m.parts];
        let part = parts[event.partIndex];
        if (!part && event.partIndex === parts.length && event.offset === 0) {
          part = { type: 'text', text: '' };
          parts.push(part);
        }
        if (!part || part.type !== 'text' || event.offset > part.text.length) {
          needsRefetch = true;
          return null;
        }
        if (event.offset + event.text.length <= part.text.length) return null; // already have it
        parts[event.partIndex] = { type: 'text', text: part.text.slice(0, event.offset) + event.text };
        return { ...m, parts, content: textOf(parts) };
      });
      if (needsRefetch || !known) void qc.invalidateQueries({ queryKey: ['conversation', event.conversationId] });
      break;
    }
    case 'message.parts': {
      const known = patchMessage(qc, event.conversationId, event.messageId, (m) => {
        // Keep locally streamed text if it is ahead of the snapshot.
        const parts = event.parts.map((p, i) => {
          const local = m.parts[i];
          return p.type === 'text' && local?.type === 'text' && local.text.length > p.text.length && local.text.startsWith(p.text) ? local : p;
        });
        return { ...m, parts, content: textOf(parts), status: event.status };
      });
      if (!known) void qc.invalidateQueries({ queryKey: ['conversation', event.conversationId] });
      if (event.status !== 'streaming' && event.status !== 'awaiting_approval') {
        void qc.invalidateQueries({ queryKey: ['conversation', event.conversationId] });
      }
      break;
    }
    case 'memory.changed':
      void qc.invalidateQueries({ queryKey: ['memory', event.workspaceId] });
      void qc.invalidateQueries({ queryKey: ['changes', event.workspaceId] });
      break;
    case 'proposals.changed':
      void qc.invalidateQueries({ queryKey: ['proposals', event.workspaceId] });
      void qc.invalidateQueries({ queryKey: ['memory', event.workspaceId] });
      break;
    case 'preferences.changed':
      if (!fromMe) void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      break;
    case 'settings.changed': {
      const keys: Record<string, string[][]> = {
        connections: [['connections'], ['models']],
        models: [['models']],
        profiles: [['profiles'], ['conversation']],
        workspace_settings: [['workspaceSettings'], ['memory'], ['conversation']],
        tools: [['toolSettings'], ['conversation']],
        backup: [['backups']],
        weather: [['weather'], ['weatherSettings']],
      };
      for (const key of keys[event.area] ?? []) void qc.invalidateQueries({ queryKey: key });
      break;
    }
    case 'usage.changed':
      void qc.invalidateQueries({ queryKey: ['usage'] });
      break;
    case 'data.restored':
      void qc.invalidateQueries();
      break;
    default:
      break;
  }
}

/** One live connection per view: keeps every open window and tab in sync with the shared service. */
export function useLiveEvents(qc: QueryClient): LiveState {
  const [state, setState] = useState<LiveState>('connecting');

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    let lastBootId: string | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = async (refreshToken: boolean): Promise<void> => {
      if (closed) return;
      let token: string;
      try {
        token = await sessionToken(refreshToken);
      } catch {
        scheduleRetry();
        return;
      }
      if (closed) return;
      source = new EventSource(`/api/events?token=${encodeURIComponent(token)}&client=${encodeURIComponent(clientId)}`);
      source.onmessage = (message) => {
        let event: AppEventEnvelope;
        try {
          event = JSON.parse(message.data) as AppEventEnvelope;
        } catch {
          return;
        }
        if (event.type === 'hello') {
          attempt = 0;
          setState('open');
          if (lastBootId && lastBootId !== event.bootId) void qc.invalidateQueries();
          lastBootId = event.bootId;
        } else {
          handle(qc, event);
        }
        for (const listener of listeners) listener(event);
      };
      source.onerror = () => {
        source?.close();
        source = null;
        setState('reconnecting');
        scheduleRetry();
      };
    };

    const scheduleRetry = (): void => {
      if (closed) return;
      attempt++;
      retryTimer = setTimeout(() => void connect(true), Math.min(10_000, 500 * 2 ** Math.min(attempt, 5)));
    };

    void connect(false);
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [qc]);

  return state;
}
