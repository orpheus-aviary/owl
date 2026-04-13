import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { CustomSection } from '@/components/settings/CustomSection';
import { ShortcutsSection } from '@/components/settings/ShortcutsSection';
import { cn } from '@/lib/utils';
import { useState } from 'react';

type SettingsTab = 'shortcuts' | 'appearance' | 'custom' | 'advanced';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'shortcuts', label: '快捷键' },
  { id: 'appearance', label: '外观' },
  { id: 'custom', label: '自定义' },
  { id: 'advanced', label: '高级' },
];

function PlaceholderSection({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">即将推出</p>
    </div>
  );
}

export function SettingsPage() {
  const [active, setActive] = useState<SettingsTab>('shortcuts');

  return (
    <div className="flex h-full">
      {/* Left vertical nav */}
      <nav className="w-40 shrink-0 border-r border-border py-4 flex flex-col gap-0.5">
        {TABS.map((tab) => (
          <button
            type="button"
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={cn(
              'text-left px-4 py-2 text-sm transition-colors',
              active === tab.id
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Right content — centered horizontally so it stays balanced when the
          global font offset grows or the window is resized. */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl px-8 py-6">
          {active === 'shortcuts' && <ShortcutsSection />}
          {active === 'appearance' && <AppearanceSection />}
          {active === 'custom' && <CustomSection />}
          {active === 'advanced' && <PlaceholderSection title="高级" />}
        </div>
      </div>
    </div>
  );
}
