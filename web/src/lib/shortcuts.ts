const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export function shortcut(key: string, shift = false): string {
  return isMac ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}
