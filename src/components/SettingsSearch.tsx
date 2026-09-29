import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Lock, Search, X } from './ui/icons';
import { useShortcut } from '../hooks/useShortcuts';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import type { SettingsPageId } from '../navigation';
import { resultKeyStep, searchSettings, type IndexedSetting, type SettingEntry } from '../services/settingsIndex';
import { focusSearchField } from '../services/shortcuts';
import { ShortcutKbd } from './ShortcutKbd';
import { SidebarSearchGroup } from './sidebar/SidebarChrome';
import { Button } from './ui/button';
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip';

const RESULT = '[data-settings-result]:not([disabled])';

/**
 * Settings' sidebar under the title row: T3's borderless "Search settings" row, fixed (`/` focuses it while the sidebar
 * shows), and under it the page list, which scrolls, or while something is typed the settings that match, grouped by
 * page. Picking one opens its page at that row.
 */
export function SettingsSearch({ index, canOpen, lockedHint, onOpen, listRef, listStyle, children }: {
  index: readonly IndexedSetting[];
  /** Whether a page opens now; one that needs the core while it's down is listed locked. */
  canOpen: (page: SettingsPageId) => boolean;
  lockedHint: string;
  onOpen: (entry: SettingEntry) => void;
  /** The scrolling list, for the shell's edge fade and for bringing the current page into view. */
  listRef?: Ref<HTMLElement>;
  listStyle?: CSSProperties;
  /** The page list, shown while nothing is typed. */
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => searchSettings(index, query), [index, query]);
  const searching = query.trim() !== '';

  // With the sidebar hidden, the field can't take focus, so `/` goes on to the page's own search, if it has one.
  useShortcut('settings.search', () => focusSearchField(field.current));

  const results = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>(RESULT) ?? []);
  const open = (entry: SettingEntry) => {
    setPicked(entry.id);
    onOpen(entry);
  };
  const clear = () => {
    setQuery('');
    setPicked(null);
    field.current?.focus();
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      results()[0]?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      results()[0]?.click();
    } else if (event.key === 'Escape' && query) {
      // Handled here, so Escape clears what's typed before it leaves Settings.
      event.preventDefault();
      clear();
    }
  };
  // The arrows move between results; up from the first, and Escape, go back to the field. Handled here, Escape doesn't
  // reach the window, where it would leave Settings.
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = results();
    const step = resultKeyStep(event.key, all.findIndex((item) => item === document.activeElement), all.length);
    if (step === null) return;
    event.preventDefault();
    (step === 'field' ? field.current : all[step])?.focus();
  };

  return (
    <>
      <SidebarSearchGroup>
        {/* T3's search row: no border or fill until it's hovered or typed in. */}
        <label className="group/search flex h-8 cursor-text items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover focus-within:bg-sidebar-row-hover" data-settings-search>
          <Search aria-hidden="true" className="size-4 shrink-0 text-[var(--sidebar-icon-color)] group-hover/search:text-sidebar-foreground group-focus-within/search:text-sidebar-foreground" />
          <input
            ref={field}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setPicked(null);
            }}
            onKeyDown={onFieldKeyDown}
            placeholder={t('settingsSearch.placeholder')}
            aria-label={t('settingsSearch.placeholder')}
            aria-controls={searching ? 'settings-search-results' : undefined}
            autoComplete="off"
            spellCheck={false}
            className="h-auto min-w-0 flex-1 bg-transparent p-0 text-sm leading-normal font-medium text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <Button variant="ghost-muted" size="icon-micro" onClick={clear} aria-label={t('settingsSearch.clear')}>
              <X />
            </Button>
          ) : <ShortcutKbd id="settings.search" className="bg-transparent text-sidebar-muted-foreground dark:bg-transparent" />}
        </label>
      </SidebarSearchGroup>
      <nav
        ref={listRef}
        style={listStyle}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2 *:shrink-0"
        aria-label={t('app.nav.settingsNavigation')}
        data-settings-search
      >
        {searching ? (
          <div ref={list} id="settings-search-results" className="flex flex-col gap-3" aria-label={t('settingsSearch.results')} role="region" onKeyDown={onListKeyDown}>
            {groups.length ? groups.map((group) => (
              <div key={group.page} className="flex flex-col gap-0.5" role="group" aria-label={group.label}>
                <div className="px-2.5 pb-1 text-xs font-medium text-sidebar-muted-foreground" aria-hidden="true">{group.label}</div>
                {group.settings.map((setting) => (
                  <SettingsResult
                    key={setting.entry.id}
                    setting={setting}
                    current={picked === setting.entry.id}
                    locked={!canOpen(setting.entry.page)}
                    lockedHint={lockedHint}
                    onOpen={() => open(setting.entry)}
                  />
                ))}
              </div>
            )) : (
              <p className="px-2.5 text-xs text-sidebar-muted-foreground" role="status">{t('settingsSearch.empty', { query: query.trim() })}</p>
            )}
          </div>
        ) : children}
      </nav>
    </>
  );
}

function SettingsResult({ setting, current, locked, lockedHint, onOpen }: {
  setting: IndexedSetting; current: boolean; locked: boolean; lockedHint: string; onOpen: () => void;
}) {
  const button = (
    <button
      type="button"
      className={cn(
        'flex min-h-10 w-full cursor-pointer items-start gap-2 rounded-[var(--control-radius)] px-2.5 py-1.5 text-left outline-none ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 active:bg-sidebar-row-active disabled:pointer-events-none disabled:opacity-50',
        current && 'bg-sidebar-row-selected shadow-xs/5 dark:shadow-none',
      )}
      disabled={locked}
      aria-current={current ? 'true' : undefined}
      data-settings-result
      onClick={onOpen}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-sidebar-foreground">{setting.title}</span>
        {setting.section !== setting.title ? (
          <span className="block truncate text-2xs text-sidebar-muted-foreground">{setting.section}</span>
        ) : null}
      </span>
      {locked ? <Lock aria-hidden="true" className="mt-1 size-3 shrink-0 text-sidebar-muted-foreground/60" /> : null}
    </button>
  );
  if (!locked) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>{button}</TooltipTrigger>
      <TooltipPopup side="right">{lockedHint}</TooltipPopup>
    </Tooltip>
  );
}
