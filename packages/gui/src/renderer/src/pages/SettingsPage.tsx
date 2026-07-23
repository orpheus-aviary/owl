import { AdvancedSection } from '@/components/settings/AdvancedSection';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { CustomSection } from '@/components/settings/CustomSection';
import { ShortcutsSection } from '@/components/settings/ShortcutsSection';
import { SyncSection } from '@/components/settings/SyncSection';
import { useIsMobile } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';
import { useEffect } from 'react';
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

// 快捷键 needs a hardware keyboard — hide it from the mobile web shell (§8).
// A `?tab=shortcuts` deep-link there redirects to the default tab.
const MOBILE_HIDDEN: ReadonlySet<SettingsTab> = new Set(['shortcuts']);
const DEFAULT_TAB: SettingsTab = 'appearance';

const TAB_IDS = new Set<SettingsTab>(TABS.map((t) => t.id));

function isValidTab(value: string | null): value is SettingsTab {
  return value !== null && TAB_IDS.has(value as SettingsTab);
}

function SectionBody({ active, hideSecrets }: { active: SettingsTab; hideSecrets: boolean }) {
  switch (active) {
    case 'shortcuts':
      return <ShortcutsSection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'custom':
      return <CustomSection hideSecrets={hideSecrets} />;
    case 'sync':
      return <SyncSection />;
    case 'advanced':
      return <AdvancedSection />;
  }
}

export function SettingsPage() {
  const isMobile = useIsMobile();
  // HashRouter + react-router-dom@7: `#/settings?tab=sync` exposes
  // `tab=sync` through useSearchParams. Deep links from
  // SyncStatusBar.popover (and future external triggers) flow through
  // here without manual `window.location.hash` parsing.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const active: SettingsTab = isValidTab(requested) ? requested : DEFAULT_TAB;

  const tabs = isMobile ? TABS.filter((t) => !MOBILE_HIDDEN.has(t.id)) : TABS;
  const hidden = isMobile && MOBILE_HIDDEN.has(active);
  const effectiveActive = hidden ? DEFAULT_TAB : active;

  // Correct the address bar when a mobile deep-link names a hidden tab; the
  // body already renders `effectiveActive` so there's no flash of a blank tab.
  useEffect(() => {
    if (hidden) setSearchParams({ tab: DEFAULT_TAB }, { replace: true });
  }, [hidden, setSearchParams]);

  const onSelect = (id: SettingsTab) => {
    setSearchParams({ tab: id }, { replace: true });
  };

  if (isMobile) {
    return (
      <div className="flex h-full flex-col">
        {/* Horizontal section switcher (single-column shell) — scrolls if the
            labels overflow a narrow phone. */}
        <nav className="shrink-0 flex gap-1 overflow-x-auto border-b border-border px-2 py-2">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              onClick={() => onSelect(tab.id)}
              className={cn(
                'shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors',
                effectiveActive === tab.id
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="flex-1 overflow-auto px-4 py-4">
          <SectionBody active={effectiveActive} hideSecrets />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left vertical nav */}
      <nav className="w-40 shrink-0 border-r border-border py-4 flex flex-col gap-0.5">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            className={cn(
              'text-left px-4 py-2 text-sm transition-colors',
              effectiveActive === tab.id
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
          <SectionBody active={effectiveActive} hideSecrets={false} />
        </div>
      </div>
    </div>
  );
}
