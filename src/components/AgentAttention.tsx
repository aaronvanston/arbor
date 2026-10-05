import { ArrowUpRight } from './ui/icons';
import { useI18n } from '../i18n';
import { liveBoardView, sessionsView, type AppView } from '../navigation';
import { needsYouRows, needsYouSummary, useFleetBoard } from '../services/fleetBoard';
import { FleetRow } from './FleetBoard';
import { SettingsBlock, SettingsSection } from './layout/settings';
import { Button } from './ui/button';

/**
 * Home's short list of the sessions that need you, from the live board: asking for approval or an answer, failed, or
 * done with a turn nobody has looked at, from the last two hours, snoozed ones left out and at most a few, saying how
 * many more the board has. Its line counts only what it lists. Hidden while there are none.
 */
export function NeedsYouSection({ onNavigate }: { onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const { board, now } = useFleetBoard();
  const { rows, more } = board ? needsYouRows(board, now) : { rows: [], more: 0 };
  if (!board || !rows.length) return null;
  const openSession = onNavigate ? (id: string) => onNavigate(sessionsView({ session: id })) : undefined;
  return (
    <SettingsSection
      title={t('home.attention.title')}
      summary={`${needsYouSummary(rows, t)} · ${t('home.attention.window')}`}
      headerAction={onNavigate ? (
        <Button variant="ghost-muted" size="sm" onClick={() => onNavigate(liveBoardView())}>
          {t('home.attention.open')}
          <ArrowUpRight />
        </Button>
      ) : undefined}
    >
      {rows.map((row) => <FleetRow key={row.key} row={row} now={now} place onOpen={openSession} />)}
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
    </SettingsSection>
  );
}
