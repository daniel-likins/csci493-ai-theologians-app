import type { ConversationKind, ProfileDto, ProfileKind, ToolGroup } from '../../../shared/types.ts';
import { parseJson, type Db } from '../db/database.ts';
import { defaultTemplateFor, type ProfileDefaults } from '../db/seed.ts';
import type { EventBus } from '../events/bus.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { effectiveToolGroups, policyFor } from './policy.ts';

interface ProfileRow {
  id: string;
  kind: ProfileKind;
  workspace_id: string | null;
  default_key: string | null;
  name: string;
  description: string;
  instructions: string;
  personality: string;
  tone: string;
  verbosity: string;
  response_structure: string;
  preferred_model_id: string | null;
  tools_json: string;
  sort_order: number;
}

export interface ProfilePatch {
  name?: string;
  description?: string;
  instructions?: string;
  personality?: string;
  tone?: string;
  verbosity?: string;
  responseStructure?: string;
  preferredModelId?: string | null;
  tools?: string[];
}

const KIND_ORDER: Record<ProfileKind, number> = { general: 0, goals: 1, master: 2 };

export class ProfileService {
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #defaults: ProfileDefaults;

  constructor(db: Db, bus: EventBus, defaults: ProfileDefaults) {
    this.#db = db;
    this.#bus = bus;
    this.#defaults = defaults;
  }

  #toDto(row: ProfileRow): ProfileDto {
    return {
      id: row.id,
      kind: row.kind,
      workspaceId: row.workspace_id,
      defaultKey: row.default_key,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      personality: row.personality,
      tone: row.tone,
      verbosity: row.verbosity,
      responseStructure: row.response_structure,
      preferredModelId: row.preferred_model_id,
      tools: effectiveToolGroups(row.kind, parseJson<string[]>(row.tools_json, [])),
      allowedTools: [...policyFor(row.kind).allowedToolGroups],
      sortOrder: row.sort_order,
      canReset: row.default_key !== null,
    };
  }

  list(): ProfileDto[] {
    return this.#db
      .all<ProfileRow>('SELECT * FROM assistant_profiles')
      .map((r) => this.#toDto(r))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  find(id: string): ProfileDto | null {
    const row = this.#db.get<ProfileRow>('SELECT * FROM assistant_profiles WHERE id = ?', id);
    return row ? this.#toDto(row) : null;
  }

  get(id: string): ProfileDto {
    const profile = this.find(id);
    if (!profile) throw notFound('Assistant');
    return profile;
  }

  findGoals(workspaceId: string): ProfileDto | null {
    const row = this.#db.get<ProfileRow>(
      "SELECT * FROM assistant_profiles WHERE kind = 'goals' AND workspace_id = ? ORDER BY sort_order LIMIT 1",
      workspaceId,
    );
    return row ? this.#toDto(row) : null;
  }

  getGoals(workspaceId: string): ProfileDto {
    const row = this.#db.get<ProfileRow>(
      "SELECT * FROM assistant_profiles WHERE kind = 'goals' AND workspace_id = ? ORDER BY sort_order LIMIT 1",
      workspaceId,
    );
    if (!row) throw notFound('Goals assistant for this workspace');
    return this.#toDto(row);
  }

  getMaster(): ProfileDto {
    const row = this.#db.get<ProfileRow>("SELECT * FROM assistant_profiles WHERE kind = 'master' ORDER BY sort_order LIMIT 1");
    if (!row) throw notFound('Master Goals assistant');
    return this.#toDto(row);
  }

  getDefaultGeneral(): ProfileDto {
    const row =
      this.#db.get<ProfileRow>("SELECT * FROM assistant_profiles WHERE default_key = 'general.assistant'") ??
      this.#db.get<ProfileRow>("SELECT * FROM assistant_profiles WHERE kind = 'general' ORDER BY sort_order LIMIT 1");
    if (!row) throw notFound('General assistant');
    return this.#toDto(row);
  }

  /** Whether a profile may be selected in a given conversation. Enforced on every selection change. */
  isUsableIn(profile: ProfileDto, conversation: { kind: ConversationKind; workspaceId: string | null }): boolean {
    if (!policyFor(profile.kind).usableIn.includes(conversation.kind)) return false;
    if (profile.kind === 'goals') return profile.workspaceId !== null && profile.workspaceId === conversation.workspaceId;
    if (profile.kind === 'general') return profile.workspaceId === null || profile.workspaceId === conversation.workspaceId;
    return true;
  }

  /** Profiles offered in the composer picker for a conversation. */
  listUsableIn(conversation: { kind: ConversationKind; workspaceId: string | null }): ProfileDto[] {
    return this.list().filter((p) => this.isUsableIn(p, conversation));
  }

  update(id: string, patch: ProfilePatch): ProfileDto {
    const current = this.get(id);
    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    if (!name) throw badRequest('An assistant needs a name.');
    if (patch.preferredModelId) {
      if (!this.#db.get('SELECT id FROM models WHERE id = ?', patch.preferredModelId)) throw notFound('Model');
    }
    const tools: ToolGroup[] = patch.tools ? effectiveToolGroups(current.kind, patch.tools) : current.tools;
    this.#db.run(
      `UPDATE assistant_profiles SET name = ?, description = ?, instructions = ?, personality = ?, tone = ?, verbosity = ?,
         response_structure = ?, preferred_model_id = ?, tools_json = ?, updated_at = ? WHERE id = ?`,
      name,
      patch.description ?? current.description,
      patch.instructions ?? current.instructions,
      patch.personality ?? current.personality,
      patch.tone ?? current.tone,
      patch.verbosity ?? current.verbosity,
      patch.responseStructure ?? current.responseStructure,
      patch.preferredModelId !== undefined ? patch.preferredModelId : current.preferredModelId,
      JSON.stringify(tools),
      nowIso(),
      id,
    );
    this.#bus.publish({ type: 'settings.changed', area: 'profiles' });
    return this.get(id);
  }

  /** Restore the default text and tools from server/defaults. The chosen model is kept. */
  resetToDefault(id: string): ProfileDto {
    const current = this.get(id);
    const workspace = current.workspaceId
      ? this.#db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', current.workspaceId)
      : null;
    const template = defaultTemplateFor(this.#defaults, current.defaultKey, workspace);
    if (!template) throw badRequest('This assistant has no default to reset to.');
    return this.update(id, {
      name: template.name,
      description: template.description,
      instructions: template.instructions,
      personality: template.personality,
      tone: template.tone,
      verbosity: template.verbosity,
      responseStructure: template.responseStructure,
      tools: template.tools,
    });
  }

  defaultsFor(id: string): Omit<ProfilePatch, 'preferredModelId'> | null {
    const current = this.get(id);
    const workspace = current.workspaceId
      ? this.#db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', current.workspaceId)
      : null;
    return defaultTemplateFor(this.#defaults, current.defaultKey, workspace);
  }

  createGeneral(input: ProfilePatch & { name: string }): ProfileDto {
    const base = this.getDefaultGeneral();
    const id = newId();
    const now = nowIso();
    const name = input.name.trim();
    if (!name) throw badRequest('An assistant needs a name.');
    this.#db.run(
      `INSERT INTO assistant_profiles (id, kind, workspace_id, default_key, name, description, instructions, personality, tone,
         verbosity, response_structure, preferred_model_id, tools_json, sort_order, created_at, updated_at)
       VALUES (?, 'general', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, ?, ?)`,
      id,
      name,
      input.description ?? '',
      input.instructions ?? base.instructions,
      input.personality ?? base.personality,
      input.tone ?? base.tone,
      input.verbosity ?? base.verbosity,
      input.responseStructure ?? base.responseStructure,
      input.preferredModelId ?? null,
      JSON.stringify(effectiveToolGroups('general', input.tools ?? base.tools)),
      now,
      now,
    );
    this.#bus.publish({ type: 'settings.changed', area: 'profiles' });
    return this.get(id);
  }

  deleteCustom(id: string): void {
    const profile = this.get(id);
    if (profile.kind !== 'general' || profile.defaultKey !== null) {
      throw forbidden('Built-in assistants can be edited or reset, but not deleted.');
    }
    this.#db.run('DELETE FROM assistant_profiles WHERE id = ?', id);
    this.#bus.publish({ type: 'settings.changed', area: 'profiles' });
  }
}
