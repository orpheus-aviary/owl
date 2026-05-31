import { AdvancedSection } from '@/components/settings/AdvancedSection';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { CustomSection } from '@/components/settings/CustomSection';
import { ShortcutsSection } from '@/components/settings/ShortcutsSection';
import { SyncSection } from '@/components/settings/SyncSection';
import { cn } from '@/lib/utils';
import { useSearchParams } from 'react-router-dom';

type SettingsTab = 'shortcuts' | 'appearance' | 'custom' | 'sync' | 'advanced';

// Order follows the common desktop-app convention: visual/content settings
// first, account/sync in the middle, power-user (shortcuts) + advanced last.
const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: '外观' },
  { id: 'custom', label: '自定义' },
  { id: 'sync', label: '同步' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'advanced', label: '高级' },
];

const TAB_IDS = new Set<SettingsTab>(TABS.map((t) => t.id));

function isValidTab(value: string | null): value is SettingsTab {
  return value !== null && TAB_IDS.has(value as SettingsTab);
}

export function SettingsPage() {
  // HashRouter + react-router-dom@7: `#/settings?tab=sync` exposes
  // `tab=sync` through useSearchParams. Deep links from
  // SyncStatusBar.popover (and future external triggers) flow through
  // here without manual `window.location.hash` parsing.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const active: SettingsTab = isValidTab(requested) ? requested : 'appearance';

  const onSelect = (id: SettingsTab) => {
    setSearchParams({ tab: id }, { replace: true });
  };

  return (
    <div className="flex h-full">
      {/* Left vertical nav */}
      <nav className="w-40 shrink-0 border-r border-border py-4 flex flex-col gap-0.5">
        {TABS.map((tab) => (
          <button
            type="button"
            key={tab.id}
            onClick={() => onSelect(tab.id)}
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
          {active === 'sync' && <SyncSection />}
          {active === 'advanced' && <AdvancedSection />}
        </div>
      </div>
    </div>
  );
}
