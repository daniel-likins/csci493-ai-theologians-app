import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolGroup } from '../../../shared/types.ts';
import { DEFAULTS_DIR } from '../config.ts';
import { newId, nowIso } from '../lib/ids.ts';
import type { Db } from './database.ts';

export interface WorkspaceDefaults {
  sections: { slug: string; name: string; sortOrder: number }[];
  workspaces: {
    slug: string;
    section: string;
    name: string;
    kind: 'mission' | 'workspace';
    hasGoals: boolean;
    sortOrder: number;
    description: string;
  }[];
}

export interface ProfileTemplate {
  name: string;
  description: string;
  instructions: string;
  personality: string;
  tone: string;
  verbosity: string;
  responseStructure: string;
  tools: ToolGroup[];
}

export interface ProfileDefaults {
  general: (ProfileTemplate & { defaultKey: string })[];
  goals: ProfileTemplate & { defaultKeyPattern: string };
  /** Per-workspace overrides of the goals template, keyed by workspace slug (each theologian's own voice). */
  goalsBySlug?: Record<string, Partial<ProfileTemplate>>;
  master: ProfileTemplate & { defaultKey: string };
}

export function loadWorkspaceDefaults(dir = DEFAULTS_DIR): WorkspaceDefaults {
  return JSON.parse(readFileSync(path.join(dir, 'workspaces.json'), 'utf8')) as WorkspaceDefaults;
}

export function loadProfileDefaults(dir = DEFAULTS_DIR): ProfileDefaults {
  return JSON.parse(readFileSync(path.join(dir, 'assistant-profiles.json'), 'utf8')) as ProfileDefaults;
}

export function goalsDefaultKey(slug: string): string {
  return `goals.${slug}`;
}

/** The default text for a profile, or null if it has no default (user-created profiles). */
export function defaultTemplateFor(
  defaults: ProfileDefaults,
  defaultKey: string | null,
  workspace?: { name: string } | null,
): ProfileTemplate | null {
  if (!defaultKey) return null;
  if (defaultKey === defaults.master.defaultKey) return defaults.master;
  const general = defaults.general.find((g) => g.defaultKey === defaultKey);
  if (general) return general;
  if (defaultKey.startsWith('goals.') && workspace) {
    const { defaultKeyPattern: _pattern, ...base } = defaults.goals;
    const merged = { ...base, ...defaults.goalsBySlug?.[defaultKey.slice('goals.'.length)] };
    return { ...merged, name: merged.name.replaceAll('{mission}', workspace.name) };
  }
  return null;
}

/**
 * Idempotently insert default sections, workspaces, settings rows, and assistant profiles.
 * Existing rows are never overwritten, so user edits survive restarts and upgrades.
 */
export function seedDefaults(db: Db, dir = DEFAULTS_DIR): void {
  const wsDefaults = loadWorkspaceDefaults(dir);
  const profileDefaults = loadProfileDefaults(dir);
  const now = nowIso();

  db.tx(() => {
    for (const section of wsDefaults.sections) {
      const exists = db.get('SELECT id FROM sections WHERE slug = ?', section.slug);
      if (!exists) {
        db.run(
          'INSERT INTO sections (id, slug, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          newId(),
          section.slug,
          section.name,
          section.sortOrder,
          now,
          now,
        );
      }
    }

    for (const ws of wsDefaults.workspaces) {
      const exists = db.get('SELECT id FROM workspaces WHERE slug = ?', ws.slug);
      if (exists) continue;
      const section = db.get<{ id: string }>('SELECT id FROM sections WHERE slug = ?', ws.section);
      if (!section) throw new Error(`Default workspace ${ws.slug} references unknown section ${ws.section}`);
      db.run(
        `INSERT INTO workspaces (id, section_id, slug, name, kind, description, has_goals, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        section.id,
        ws.slug,
        ws.name,
        ws.kind,
        ws.description,
        ws.hasGoals,
        ws.sortOrder,
        now,
        now,
      );
    }

    // Every workspace gets a settings row.
    db.run(
      `INSERT INTO workspace_settings (workspace_id, updated_at)
       SELECT id, ? FROM workspaces WHERE id NOT IN (SELECT workspace_id FROM workspace_settings)`,
      now,
    );

    const insertProfile = (
      kind: 'general' | 'goals' | 'master',
      workspaceId: string | null,
      defaultKey: string,
      t: ProfileTemplate,
      sortOrder: number,
    ): void => {
      if (db.get('SELECT id FROM assistant_profiles WHERE default_key = ?', defaultKey)) return;
      db.run(
        `INSERT INTO assistant_profiles
           (id, kind, workspace_id, default_key, name, description, instructions, personality, tone, verbosity,
            response_structure, tools_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        kind,
        workspaceId,
        defaultKey,
        t.name,
        t.description,
        t.instructions,
        t.personality,
        t.tone,
        t.verbosity,
        t.responseStructure,
        JSON.stringify(t.tools),
        sortOrder,
        now,
        now,
      );
    };

    profileDefaults.general.forEach((g, i) => insertProfile('general', null, g.defaultKey, g, i));
    insertProfile('master', null, profileDefaults.master.defaultKey, profileDefaults.master, 0);
    const goalWorkspaces = db.all<{ id: string; slug: string; name: string; sort_order: number }>(
      'SELECT id, slug, name, sort_order FROM workspaces WHERE has_goals = 1',
    );
    for (const ws of goalWorkspaces) {
      const template = defaultTemplateFor(profileDefaults, goalsDefaultKey(ws.slug), ws)!;
      insertProfile('goals', ws.id, goalsDefaultKey(ws.slug), template, ws.sort_order);
    }
  });
}
