import { useState, type FormEvent, type ReactNode } from 'react';
import { Dialog } from '../components/Dialog.tsx';
import { toastError } from '../components/toast.tsx';
import { Button, Field } from '../components/ui.tsx';

export function SecretDialog({
  title,
  label,
  hint,
  onSave,
  onClose,
}: {
  title: string;
  label: string;
  hint?: ReactNode;
  onSave: (secret: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onSave(value.trim());
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="secret-form" disabled={!value.trim() || busy}>
            Save securely
          </Button>
        </>
      }
    >
      <form id="secret-form" onSubmit={(e) => void submit(e)}>
        <Field label={label} htmlFor="secret-input" hint={hint ?? 'Stored in your operating system’s credential store. It is never shown again, logged, or included in exports.'}>
          <input id="secret-input" className="input" type="password" autoComplete="off" spellCheck={false} data-autofocus value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

export function SettingsGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-group" aria-label={title}>
      <div className="card-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export const TOOL_GROUP_LABELS: Record<string, { label: string; description: string }> = {
  web_search: { label: 'Web search', description: 'Search the web when web search is on for a chat' },
  attachments: { label: 'Read attachments', description: 'Read more of long PDFs and files attached to a chat' },
  files: { label: 'Read and edit files', description: 'Only in the theologian working folder; edits need approval' },
  run_command: { label: 'Run commands', description: 'Sandboxed in the working folder; each command needs approval' },
  mission_history: { label: 'Look up past chats', description: "Search this theologian's earlier conversations" },
  memory_proposals: { label: 'Suggest memory updates', description: "Follows the theologian's approval or autosave setting" },
};
