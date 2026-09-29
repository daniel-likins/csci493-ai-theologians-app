import type {
  CheckinFrequency,
  GeneralContext,
  HistoryAccess,
  SectionDto,
  WorkspaceDto,
  WorkspaceSettingsDto,
} from '../../../shared/types.ts';
import { toBool, type Db } from '../db/database.ts';
import type { EventBus } from '../events/bus.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { nowIso } from '../lib/ids.ts';

interface WorkspaceRow {
  id: string;
  section_id: string;
  slug: string;
  name: string;
  kind: 'mission' | 'workspace';
  description: string;
  has_goals: number;
  sort_order: number;
}

interface SettingsRow {
  workspace_id: string;
  memory_autosave: number;
  memory_suggestions: number;
  history_access: HistoryAccess;
  general_context: GeneralContext;
  checkin_frequency: CheckinFrequency;
  last_checkin_at: string | null;
  checkin_snoozed_until: string | null;
  working_folder: string | null;
}

function toWorkspace(row: WorkspaceRow): WorkspaceDto {
  return {
    id: row.id,
    sectionId: row.section_id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    description: row.description,
    hasGoals: toBool(row.has_goals),
    sortOrder: row.sort_order,
  };
}

function toSettings(row: SettingsRow): WorkspaceSettingsDto {
  return {
    workspaceId: row.workspace_id,
    memoryAutosave: toBool(row.memory_autosave),
    memorySuggestions: toBool(row.memory_suggestions),
    historyAccess: row.history_access,
    generalContext: row.general_context,
    checkinFrequency: row.checkin_frequency,
    lastCheckinAt: row.last_checkin_at,
    checkinSnoozedUntil: row.checkin_snoozed_until,
    workingFolder: row.working_folder,
  };
}

export interface WorkspaceSettingsPatch {
  memoryAutosave?: boolean;
  memorySuggestions?: boolean;
  historyAccess?: HistoryAccess;
  generalContext?: GeneralContext;
  checkinFrequency?: CheckinFrequency;
  lastCheckinAt?: string | null;
  checkinSnoozedUntil?: string | null;
  workingFolder?: string | null;
}

export class WorkspaceService {
  readonly #db: Db;
  readonly #bus: EventBus;

  constructor(db: Db, bus: EventBus) {
    this.#db = db;
    this.#bus = bus;
  }

  listSections(): SectionDto[] {
    return this.#db
      .all<{ id: string; slug: string; name: string; sort_order: number }>(
        'SELECT id, slug, name, sort_order FROM sections ORDER BY sort_order, name',
      )
      .map((r) => ({ id: r.id, slug: r.slug, name: r.name, sortOrder: r.sort_order }));
  }

  list(): WorkspaceDto[] {
    return this.#db
      .all<WorkspaceRow>('SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY sort_order, name')
      .map(toWorkspace);
  }

  listWithGoals(): WorkspaceDto[] {
    return this.list().filter((w) => w.hasGoals);
  }

  get(id: string): WorkspaceDto {
    const row = this.#db.get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', id);
    if (!row) throw notFound('Workspace');
    return toWorkspace(row);
  }

  find(id: string): WorkspaceDto | null {
    const row = this.#db.get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', id);
    return row ? toWorkspace(row) : null;
  }

  getBySlug(slug: string): WorkspaceDto {
    const row = this.#db.get<WorkspaceRow>('SELECT * FROM workspaces WHERE slug = ?', slug);
    if (!row) throw notFound('Workspace');
    return toWorkspace(row);
  }

  update(id: string, patch: { name?: string; description?: string }): WorkspaceDto {
    const current = this.get(id);
    const name = patch.name?.trim() ?? current.name;
    if (!name) throw badRequest('A workspace needs a name.');
    this.#db.run(
      'UPDATE workspaces SET name = ?, description = ?, updated_at = ? WHERE id = ?',
      name,
      patch.description ?? current.description,
      nowIso(),
      id,
    );
    this.#bus.publish({ type: 'workspaces.changed' });
    return this.get(id);
  }

  getSettings(workspaceId: string): WorkspaceSettingsDto {
    const row = this.#db.get<SettingsRow>('SELECT * FROM workspace_settings WHERE workspace_id = ?', workspaceId);
    if (!row) throw notFound('Workspace settings');
    return toSettings(row);
  }

  updateSettings(workspaceId: string, patch: WorkspaceSettingsPatch): WorkspaceSettingsDto {
    const current = this.getSettings(workspaceId);
    const next = { ...current, ...patch };
    this.#db.run(
      `UPDATE workspace_settings SET memory_autosave = ?, memory_suggestions = ?, history_access = ?, general_context = ?,
         checkin_frequency = ?, last_checkin_at = ?, checkin_snoozed_until = ?, working_folder = ?, updated_at = ?
       WHERE workspace_id = ?`,
      next.memoryAutosave,
      next.memorySuggestions,
      next.historyAccess,
      next.generalContext,
      next.checkinFrequency,
      next.lastCheckinAt,
      next.checkinSnoozedUntil,
      next.workingFolder,
      nowIso(),
      workspaceId,
    );
    this.#bus.publish({ type: 'settings.changed', area: 'workspace_settings' });
    return this.getSettings(workspaceId);
  }
}
