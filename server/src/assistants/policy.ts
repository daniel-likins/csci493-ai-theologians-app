import type { ConversationKind, ProfileKind, ToolGroup } from '../../../shared/types.ts';

/**
 * Data-access policy for each assistant kind. This is the enforcement point for what an assistant
 * may read and write. It is deliberately NOT editable from Settings: editing a profile's
 * instructions or personality can never grant it more access.
 */
export interface AssistantPolicy {
  readonly kind: ProfileKind;
  /** Tool groups this kind may ever use. A profile can switch some off, never add more. */
  readonly allowedToolGroups: readonly ToolGroup[];
  /**
   * mission_brief — the mission name/description (and optionally current focus), nothing else.
   * own_mission — the full curated memory of its own mission.
   * all_missions_readonly — read-only snapshots of every mission's curated memory.
   */
  readonly memoryRead: 'mission_brief' | 'own_mission' | 'all_missions_readonly';
  /** Only Goals assistants may *propose* memory changes, and only for their own mission. */
  readonly memoryWrite: 'none' | 'propose_own_mission';
  /** Conversation kinds this assistant may be selected in. */
  readonly usableIn: readonly ConversationKind[];
}

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

const POLICIES: Readonly<Record<ProfileKind, AssistantPolicy>> = freeze({
  general: freeze({
    kind: 'general',
    allowedToolGroups: freeze(['web_search', 'attachments', 'files', 'run_command'] as ToolGroup[]),
    memoryRead: 'mission_brief',
    memoryWrite: 'none',
    usableIn: freeze(['chat'] as ConversationKind[]),
  }),
  goals: freeze({
    kind: 'goals',
    allowedToolGroups: freeze(['web_search', 'attachments', 'mission_history', 'memory_proposals'] as ToolGroup[]),
    memoryRead: 'own_mission',
    memoryWrite: 'propose_own_mission',
    usableIn: freeze(['chat', 'goals'] as ConversationKind[]),
  }),
  master: freeze({
    kind: 'master',
    // Read-only by construction: no memory_proposals, no mission_history, no files, no commands.
    allowedToolGroups: freeze(['web_search', 'attachments'] as ToolGroup[]),
    memoryRead: 'all_missions_readonly',
    memoryWrite: 'none',
    usableIn: freeze(['master'] as ConversationKind[]),
  }),
});

export const ALL_TOOL_GROUPS: readonly ToolGroup[] = freeze([
  'web_search',
  'attachments',
  'files',
  'run_command',
  'mission_history',
  'memory_proposals',
]);

export function policyFor(kind: ProfileKind): AssistantPolicy {
  const policy = POLICIES[kind];
  if (!policy) throw new Error(`Unknown assistant kind: ${kind}`);
  return policy;
}

/** The requested tool groups, restricted to what policy allows for this kind. */
export function effectiveToolGroups(kind: ProfileKind, requested: readonly string[]): ToolGroup[] {
  const allowed = policyFor(kind).allowedToolGroups;
  return allowed.filter((group) => requested.includes(group));
}

export function mayProposeMemory(kind: ProfileKind): boolean {
  return policyFor(kind).memoryWrite === 'propose_own_mission';
}
