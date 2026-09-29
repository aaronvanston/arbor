import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { invokeCommand } from '../native/commands';
import { ExternalLink } from './ui/icons';
import { useI18n } from '../i18n';
import type { ReleaseNotesView } from '../services/releaseNotes';
import { createPopoverHandle, Popover, PopoverPopup, PopoverTrigger } from './ui/popover';
import { toast } from './ui/toast';

function ReleaseLink({ url, children }: { url: string; children: string }) {
  const { t } = useI18n();
  const open = () => {
    invokeCommand('open_external_url', { url }).catch((error: unknown) =>
      toast({ kind: 'error', title: t('releaseNotes.openFailed'), description: String(error) }),
    );
  };
  return (
    <button
      type="button"
      className="mt-1.5 inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground underline decoration-dotted underline-offset-4 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      onClick={open}
    >
      {children}
      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
    </button>
  );
}

/**
 * The releases an update brings, newest first, as plain text: each one's summary and first few changes, with GitHub
 * for the rest. `titleNewest` heads the newest release "What's changed" (the update pill); otherwise every release is
 * headed by its version.
 */
export function ReleaseNoteSections({
  view,
  releaseUrl,
  releasesUrl,
  titleNewest = false,
}: {
  view: ReleaseNotesView;
  releaseUrl: (version: string) => string;
  releasesUrl: string;
  titleNewest?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col divide-y divide-border/70">
      {view.sections.map((section, index) => (
        <section key={section.version} className="py-3 first:pt-0 last:pb-0">
          <h3 className="text-xs leading-4 font-semibold text-foreground">
            {titleNewest && index === 0 ? t('releaseNotes.whatsChanged') : t('releaseNotes.changesIn', { version: `v${section.version}` })}
          </h3>
          {section.summary ? <p className="mt-1.5 text-xs leading-5 text-foreground">{section.summary}</p> : null}
          {section.changes.length ? (
            <ul className="mt-1.5 flex flex-col gap-1 pl-4 text-xs leading-5 text-popover-foreground/90">
              {section.changes.map((change, changeIndex) => (
                // A release can list the same line twice, so the position keeps keys apart.
                <li key={`${changeIndex}:${change}`} className="list-disc break-words">{change}</li>
              ))}
            </ul>
          ) : null}
          <ReleaseLink url={releaseUrl(section.version)}>
            {section.moreChanges
              ? t(section.moreChanges === 1 ? 'releaseNotes.moreChanges.one' : 'releaseNotes.moreChanges.other', { count: section.moreChanges })
              : t('releaseNotes.viewRelease')}
          </ReleaseLink>
        </section>
      ))}
      {view.olderReleases ? (
        <div className="pt-3">
          <ReleaseLink url={releasesUrl}>
            {t(view.olderReleases === 1 ? 'releaseNotes.olderReleases.one' : 'releaseNotes.olderReleases.other', { count: view.olderReleases })}
          </ReleaseLink>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The update pill with what the update changes beside it: the card opens on hover or keyboard focus,
 * while a press still does what the pill does. Tab from the pill moves into the card's links, and past the last one on
 * through the sidebar.
 */
export function UpdatePillNotes({
  view,
  header,
  button,
  releaseUrl,
  releasesUrl,
  enabled,
}: {
  view: ReleaseNotesView;
  header: ReactNode;
  button: ReactElement;
  releaseUrl: (version: string) => string;
  releasesUrl: string;
  /** Off while the sidebar is hidden, which closes the card. */
  enabled: boolean;
}) {
  const { t } = useI18n();
  const [handle] = useState(() => createPopoverHandle());
  const triggerId = useId();
  const popupRef = useRef<HTMLDivElement>(null);
  // Escape from inside the card sends focus back to the pill, which mustn't open it again.
  const suppressFocusOpen = useRef(false);
  const show = enabled && view.sections.length > 0;

  useEffect(() => {
    if (!show) handle.close();
  }, [handle, show]);

  return (
    <Popover
      handle={handle}
      onOpenChange={(open, details) => {
        if (open && !show) {
          details.cancel();
          return;
        }
        // A press opens Updates, so it mustn't also toggle the card.
        if (details.reason === 'trigger-press') details.cancel();
      }}
    >
      <PopoverTrigger
        {...(show ? {} : { 'aria-controls': undefined, 'aria-expanded': undefined, 'aria-haspopup': undefined })}
        id={triggerId}
        handle={handle}
        openOnHover={show}
        closeDelay={150}
        render={button}
        onClick={() => handle.close()}
        onBlur={() => {
          suppressFocusOpen.current = false;
        }}
        onFocus={(event) => {
          if (!show || !event.currentTarget.matches(':focus-visible')) return;
          if (suppressFocusOpen.current) {
            suppressFocusOpen.current = false;
            return;
          }
          flushSync(() => handle.open(triggerId));
        }}
        onKeyDown={(event) => {
          // A card opened by hover doesn't manage focus; opening it here first lets Tab move into it.
          if (!show || event.key !== 'Tab' || event.shiftKey) return;
          flushSync(() => handle.open(triggerId));
        }}
      />
      {show ? (
        <PopoverPopup
          ref={popupRef}
          side="right"
          align="end"
          sideOffset={8}
          width="lg"
          aria-label={t('releaseNotes.label')}
          initialFocus={false}
          onKeyDownCapture={(event) => {
            if (event.key === 'Escape' && popupRef.current?.contains(document.activeElement)) suppressFocusOpen.current = true;
          }}
        >
          <div className="mb-3">{header}</div>
          <ReleaseNoteSections view={view} releaseUrl={releaseUrl} releasesUrl={releasesUrl} titleNewest />
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}
