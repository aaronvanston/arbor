import type { ReactNode } from 'react';
import { ArrowUpRight } from './ui/icons';
import { requestFocus } from '../focusRequests';
import { useI18n } from '../i18n';
import { liveBoardView, sessionsView, type AppView } from '../navigation';
import { needsYouRows, needsYouSummary, useFleetBoard } from '../services/fleetBoard';
import { FleetRow } from './FleetBoard';
import { SettingsBlock, SettingsSection } from './layout/settings';
import { Button } from './ui/button';
import { useEffect } from 'react';
import { launchHomeShape, needsYouLikely, rememberHomeShape } from '../boot/bootState';
import { NeedsYouSkeleton, NeedsYouSummarySkeleton } from './homeSkeletons';

/**
 * Home's short list of the sessions that need you, from the live board: asking for approval or an answer, failed, or
 * done with a turn nobody has looked at, from the last two hours, snoozed ones left out and at most a few, saying how
 * many more the board has. Its line counts only what it lists. Hidden while there are none.
 */
export function NeedsYouSection({ onNavigate }: { onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const { board, now } = useFleetBoard();
  const { rows, more } = board ? needsYouRows(board, now) : { rows: [], more: 0 };
  // The next launch's first screen draws as many rows, while they're still likely to be there (counts and a minute).
  const minute = Math.floor(now / 60_000);
  useEffect(() => {
    if (board) rememberHomeShape({ needsYou: { rows: rows.length, more: more > 0, at: minute * 60_000 } });
  }, [board, rows.length, more, minute]);
  if (!board) {
    // Until the board is read: the rows the first screen drew, if it drew any, so the sections under them stay put.
    const shape = launchHomeShape().needsYou;
    return needsYouLikely(shape, now) ? needsYouFrame(t, onNavigate, <NeedsYouSummarySkeleton />, <NeedsYouSkeleton rows={shape.rows} more={shape.more} />) : null;
  }
  if (!rows.length) return null;
  const openSession = onNavigate ? (id: string) => onNavigate(sessionsView({ session: id })) : undefined;
  // A session Arbor has no page for (a T3 Code thread, an agent that only reports) opens the board at its row.
  const openOnBoard = onNavigate ? (key: string) => {
    requestFocus('fleet-session', key);
    onNavigate(liveBoardView());
  } : undefined;
  return needsYouFrame(t, onNavigate, `${needsYouSummary(rows, t)} · ${t('home.attention.window')}`, (
    <>
      {rows.map((row) => <FleetRow key={row.key} row={row} now={now} place onOpen={openSession} onOpenBoard={openOnBoard} />)}
      {more > 0 ? (
        <SettingsBlock className="py-2 text-xs text-muted-foreground">
          {/* The rest are on the board, so the line opens it. */}
          {onNavigate ? (
            <button type="button" className="cursor-pointer underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline" onClick={() => onNavigate(liveBoardView())}>
              {t(more === 1 ? 'home.attention.more.one' : 'home.attention.more.other', { count: more })}
            </button>
          ) : t(more === 1 ? 'home.attention.more.one' : 'home.attention.more.other', { count: more })}
        </SettingsBlock>
      ) : null}
    </>
  ));
}

/**
 * The section around Needs you's rows, or its skeleton's: the title, its line of counts, and Open board. A plain
 * function rather than a component, so the section doesn't render one more component every time the board moves.
 */
function needsYouFrame(t: ReturnType<typeof useI18n>['t'], onNavigate: ((view: AppView) => void) | undefined, summary: ReactNode, children: ReactNode) {
  return (
    <SettingsSection
      title={t('home.attention.title')}
      summary={summary}
      headerAction={onNavigate ? (
        <Button variant="ghost-muted" size="sm" onClick={() => onNavigate(liveBoardView())}>
          {t('home.attention.open')}
          <ArrowUpRight />
        </Button>
      ) : undefined}
    >
      {children}
    </SettingsSection>
  );
}
