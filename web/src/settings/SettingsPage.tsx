import { ArrowLeft, BarChart3, Bot, Cpu, HardDrive, Info, SlidersHorizontal, Target, Wrench } from 'lucide-react';
import { useEffect, type ComponentType } from 'react';
import { lastNonSettingsPath, navigate, paths } from '../lib/router.ts';
import { AboutSettings } from './AboutSettings.tsx';
import { AssistantsSettings } from './AssistantsSettings.tsx';
import { DataSettings } from './DataSettings.tsx';
import { GeneralSettings } from './GeneralSettings.tsx';
import { MissionsSettings } from './MissionsSettings.tsx';
import { ModelsSettings } from './ModelsSettings.tsx';
import { ToolsSettings } from './ToolsSettings.tsx';
import { UsageSettings } from './UsageSettings.tsx';

const SECTIONS: { id: string; label: string; icon: ComponentType<{ size?: number }>; Component: ComponentType }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, Component: GeneralSettings },
  { id: 'models', label: 'Models', icon: Cpu, Component: ModelsSettings },
  { id: 'assistants', label: 'Assistants', icon: Bot, Component: AssistantsSettings },
  { id: 'missions', label: 'Theologians', icon: Target, Component: MissionsSettings },
  { id: 'tools', label: 'Tools & pertheologians', icon: Wrench, Component: ToolsSettings },
  { id: 'data', label: 'Data & backups', icon: HardDrive, Component: DataSettings },
  { id: 'usage', label: 'Usage', icon: BarChart3, Component: UsageSettings },
  { id: 'about', label: 'About & service', icon: Info, Component: AboutSettings },
];

export function SettingsPage({ section }: { section: string }) {
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.dialog-overlay, .popover')) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      navigate(lastNonSettingsPath());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <button type="button" className="nav-row back" onClick={() => navigate(lastNonSettingsPath())} title="Back (Esc)">
          <ArrowLeft size={16} aria-hidden="true" />
          <span>Back</span>
        </button>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className="nav-row" aria-current={current.id === id ? 'page' : undefined} onClick={() => navigate(paths.settings(id), { replace: true })}>
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="settings-content">
        <div className="settings-inner">
          <current.Component />
        </div>
      </div>
    </div>
  );
}
