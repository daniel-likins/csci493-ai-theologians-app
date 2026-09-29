import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { badRequest, conflict, forbidden } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { truncate } from '../lib/text.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', 'target', '.gradle', '.idea']);
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 60_000;

export function sensitivePaths(dataDir: string): string[] {
  const home = os.homedir();
  const common = [
    dataDir,
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.globus'),
    path.join(home, '.azure'),
    path.join(home, '.docker'),
    path.join(home, '.kube'),
    path.join(home, '.netrc'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.config', 'gh'),
    path.join(home, '.config', 'glab'),
    path.join(home, '.local', 'share', 'keyrings'),
    path.join(home, '.password-store'),
  ];
  if (process.platform === 'darwin') {
    common.push(path.join(home, 'Library', 'Keychains'), path.join(home, 'Library', 'Cookies'));
  } else if (process.platform === 'win32') {
    for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
      if (base) common.push(path.join(base, 'Microsoft', 'Credentials'), path.join(base, 'Microsoft', 'Vault'));
    }
  }
  return common;
}

function isWithin(child: string, parent: string): boolean {
  const normalize = (value: string): string => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  const normalizedChild = normalize(child);
  const normalizedParent = normalize(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + path.sep);
}

export function isSensitive(abs: string, dataDir: string): boolean {
  return sensitivePaths(dataDir).some((p) => isWithin(abs, p));
}

/** Validate a folder the user chose as a working folder. */
export async function validateWorkingFolder(folder: string, dataDir: string): Promise<string> {
  if (!path.isAbsolute(folder)) throw badRequest('Choose a folder using its full path.');
  let real: string;
  try {
    real = await realpath(folder);
  } catch {
    throw badRequest("That folder doesn't exist.");
  }
  if (!(await stat(real)).isDirectory()) throw badRequest('That path is not a folder.');
  const home = await realpath(os.homedir());
  const systemRoots = process.platform === 'win32'
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData].filter((value): value is string => Boolean(value))
    : process.platform === 'darwin'
      ? ['/System', '/Library', '/usr', '/bin', '/sbin', '/private', '/etc', '/var', '/Applications', '/cores', '/opt']
      : ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/var', '/opt', '/proc', '/sys', '/dev', '/run'];
  const blockedTrees = process.platform === 'darwin' ? ['/System', '/usr'] : systemRoots;
  if (real === path.parse(real).root || real === home || real === path.dirname(home) || systemRoots.includes(real) || blockedTrees.some((root) => isWithin(real, root))) {
    throw badRequest('Choose a specific project folder, not your whole home folder or a system folder.');
  }
  if (isSensitive(real, dataDir) || isWithin(dataDir, real)) {
    throw badRequest("That folder contains private data (such as Theologians' own database or credentials), so it can't be a working folder.");
  }
  return real;
}

export class FileScope {
  readonly root: string;
  readonly dataDir: string;

  constructor(root: string, dataDir: string) {
    this.root = root;
    this.dataDir = dataDir;
  }

  /** Resolve a path, following symlinks, so nothing can escape the working folder through a link. */
  async resolve(input: string): Promise<{ abs: string; rel: string; inside: boolean; exists: boolean }> {
    if (typeof input !== 'string') throw badRequest('Path must be a string.');
    const candidate = path.resolve(this.root, input.replace(/^~(?=$|[\\/])/, os.homedir()));
    let real: string;
    let exists = true;
    try {
      real = await realpath(candidate);
    } catch {
      exists = false;
      const rest: string[] = [path.basename(candidate)];
      let parent = path.dirname(candidate);
      for (;;) {
        try {
          real = path.join(await realpath(parent), ...rest);
          break;
        } catch {
          if (parent === path.dirname(parent)) {
            real = candidate;
            break;
          }
          rest.unshift(path.basename(parent));
          parent = path.dirname(parent);
        }
      }
    }
    const inside = isWithin(real, this.root);
    return { abs: real, rel: inside ? path.relative(this.root, real) || '.' : real, inside, exists };
  }

  assertNotSensitive(abs: string): void {
    if (isSensitive(abs, this.dataDir)) throw forbidden('That location holds private data and is never readable by tools.');
  }
}

export async function listDirectory(abs: string, displayPath: string): Promise<string> {
  const info = await stat(abs).catch(() => null);
  if (!info) throw badRequest(`“${displayPath}” doesn't exist.`);
  if (!info.isDirectory()) throw badRequest(`“${displayPath}” is a file, not a folder.`);
  const entries = await readdir(abs, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const entry of entries.slice(0, 500)) {
    if (entry.name === '.DS_Store') continue;
    if (entry.isDirectory()) lines.push(`${entry.name}/${SKIP_DIRS.has(entry.name) ? '  (skipped by search)' : ''}`);
    else if (entry.isSymbolicLink()) lines.push(`${entry.name}  (symlink)`);
    else {
      const size = (await stat(path.join(abs, entry.name)).catch(() => null))?.size ?? 0;
      lines.push(`${entry.name}  (${size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`})`);
    }
  }
  if (entries.length > 500) lines.push(`… ${entries.length - 500} more entries`);
  return `${displayPath}/\n${lines.join('\n') || '(empty folder)'}`;
}

async function readTextBuffer(abs: string, displayPath: string): Promise<string> {
  const info = await stat(abs).catch(() => null);
  if (!info) throw badRequest(`“${displayPath}” doesn't exist.`);
  if (info.isDirectory()) throw badRequest(`“${displayPath}” is a folder. Use list_files instead.`);
  if (info.size > MAX_READ_BYTES) throw badRequest(`“${displayPath}” is larger than 5 MB and can't be read.`);
  const buffer = await readFile(abs);
  if (buffer.subarray(0, 8192).includes(0)) throw badRequest(`“${displayPath}” looks like a binary file.`);
  return buffer.toString('utf8');
}

export async function readTextFile(abs: string, displayPath: string, startLine?: number, endLine?: number): Promise<string> {
  const text = await readTextBuffer(abs, displayPath);
  const lines = text.split('\n');
  const start = Math.max(1, Math.floor(startLine ?? 1));
  const end = Math.min(lines.length, Math.floor(endLine ?? lines.length));
  const width = String(end).length;
  const body = lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(width)}| ${line}`)
    .join('\n');
  const header = `${displayPath} (lines ${start}–${end} of ${lines.length})`;
  return truncate(`${header}\n${body}`, MAX_OUTPUT_CHARS, `\n…[output truncated; read a smaller line range]`);
}

export async function searchFiles(root: string, startAbs: string, query: string): Promise<string> {
  const needle = query.toLowerCase();
  if (!needle.trim()) throw badRequest('Search text is empty.');
  const matches: string[] = [];
  let scanned = 0;
  const walk = async (dir: string): Promise<void> => {
    if (matches.length >= 80 || scanned >= 8000) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (matches.length >= 80 || scanned >= 8000) return;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(full).catch(() => null);
      if (!info || info.size > 1024 * 1024) continue;
      scanned++;
      const buffer = await readFile(full).catch(() => null);
      if (!buffer || buffer.subarray(0, 4096).includes(0)) continue;
      const lines = buffer.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          matches.push(`${path.relative(root, full)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          if (matches.length >= 80) break;
        }
      }
    }
  };
  await walk(startAbs);
  const tail = matches.length >= 80 ? '\n…more matches not shown; refine the search.' : '';
  return matches.length ? `${matches.length} match(es) in ${scanned} file(s) searched:\n${matches.join('\n')}${tail}` : `No matches for “${query}” in ${scanned} file(s).`;
}

export interface EditProposal {
  abs: string;
  rel: string;
  before: string | null;
  after: string;
  diff: string;
  isNew: boolean;
}

export async function prepareEdit(
  scope: FileScope,
  inputPath: string,
  change: { newContent?: string; find?: string; replace?: string },
): Promise<EditProposal> {
  const target = await scope.resolve(inputPath);
  if (!target.inside) throw forbidden('File edits are limited to the working folder.');
  scope.assertNotSensitive(target.abs);
  let before: string | null = null;
  if (target.exists) before = await readTextBuffer(target.abs, target.rel);
  let after: string;
  if (change.find !== undefined) {
    if (before === null) throw badRequest(`“${target.rel}” doesn't exist, so there is nothing to replace.`);
    if (!change.find) throw badRequest('The text to find is empty.');
    const occurrences = before.split(change.find).length - 1;
    if (occurrences === 0) throw badRequest(`The text to replace wasn't found in “${target.rel}”. Read the file and copy the exact text.`);
    if (occurrences > 1) throw badRequest(`The text to replace appears ${occurrences} times in “${target.rel}”. Include more surrounding lines so it matches once.`);
    after = before.replace(change.find, () => change.replace ?? '');
  } else if (change.newContent !== undefined) {
    after = change.newContent;
  } else {
    throw badRequest('Provide either new_content, or find and replace.');
  }
  if (before !== null && before === after) throw badRequest('The proposed edit makes no changes.');
  const diff = createTwoFilesPatch(target.rel, target.rel, before ?? '', after, before === null ? '(new file)' : '', '', { context: 3 });
  return { abs: target.abs, rel: target.rel, before, after, diff: truncate(diff, 200_000), isNew: before === null };
}

/** Write an approved edit, refusing if the file changed after the diff was shown. */
export async function applyEdit(scope: FileScope, proposal: EditProposal): Promise<void> {
  const again = await scope.resolve(proposal.abs);
  if (!again.inside) throw forbidden('File edits are limited to the working folder.');
  const current = existsSync(proposal.abs) ? await readTextBuffer(proposal.abs, proposal.rel) : null;
  if (current !== proposal.before) throw conflict(`“${proposal.rel}” changed after the edit was proposed, so nothing was written.`);
  await mkdir(path.dirname(proposal.abs), { recursive: true });
  const tmp = path.join(path.dirname(proposal.abs), `.${path.basename(proposal.abs)}.${newId()}.tmp`);
  await writeFile(tmp, proposal.after, 'utf8');
  await rename(tmp, proposal.abs);
}
