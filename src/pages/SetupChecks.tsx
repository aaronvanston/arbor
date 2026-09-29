import { useState } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, type AppIcon } from '../components/ui/icons';
import { useConfirmation } from '../components/ConfirmationDialog';
import { MetaLine } from '../components/MetaLine';
import { MachinePill } from '../components/identity/Identity';
import { SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { useI18n } from '../i18n';
import { formatNumber } from '../lib/format';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { checkCounts, keepClaudeSessions, KEEP_DAYS, type SetupCheck, type SetupCheckKind, type SetupCheckLevel, type SetupCheckSubject } from '../services/setupChecks';

/** How many checks show before "Show all". */
const COLLAPSED = 5;

const LEVEL_LOOK: Record<SetupCheckLevel, { icon: AppIcon; className: string; label: MessageKey; count: [MessageKey, MessageKey]; badge: 'error' | 'warning' | 'info' }> = {
  problem: { icon: CircleAlert, className: 'text-error-foreground', label: 'setup.checks.level.problem', count: ['setup.checks.problems.one', 'setup.checks.problems.other'], badge: 'error' },
  warning: { icon: TriangleAlert, className: 'text-warning-foreground', label: 'setup.checks.level.warning', count: ['setup.checks.warnings.one', 'setup.checks.warnings.other'], badge: 'warning' },
  note: { icon: Info, className: 'text-info-foreground', label: 'setup.checks.level.note', count: ['setup.checks.notes.one', 'setup.checks.notes.other'], badge: 'info' },
};

type Plural = [one: MessageKey, other: MessageKey];

/**
 * Each kind's message: its title, what it means (by count, or by which agent), and what's said
 * beside each thing it's about.
 */
const MESSAGE: Record<SetupCheckKind, { title: MessageKey | Plural; detail: MessageKey | Plural | Record<'claude' | 'codex', MessageKey>; value?: MessageKey }> = {
  scanFailed: { title: 'setup.check.scanFailed.title', detail: 'setup.check.scanFailed.detail' },
  unreadable: { title: 'setup.check.unreadable.title', detail: 'setup.check.unreadable.detail' },
  policyUnreadable: { title: 'setup.check.policyUnreadable.title', detail: 'setup.check.policyUnreadable.detail' },
  sessionCleanup: {
    title: ['setup.check.sessionCleanup.title.one', 'setup.check.sessionCleanup.title.other'],
    detail: 'setup.check.sessionCleanup.detail',
  },
  brokenImport: {
    title: ['setup.check.brokenImport.title.one', 'setup.check.brokenImport.title.other'],
    detail: 'setup.check.brokenImport.detail',
    value: 'setup.check.importedIn',
  },
  deepImport: {
    title: ['setup.check.deepImport.title.one', 'setup.check.deepImport.title.other'],
    detail: 'setup.check.deepImport.detail',
    value: 'setup.check.importedIn',
  },
  brokenLink: {
    title: ['setup.check.brokenLink.title.one', 'setup.check.brokenLink.title.other'],
    detail: 'setup.check.brokenLink.detail',
    value: 'setup.check.linksTo',
  },
  tooLarge: { title: ['setup.check.tooLarge.title.one', 'setup.check.tooLarge.title.other'], detail: 'setup.check.tooLarge.detail' },
  skillNoDoc: {
    title: ['setup.check.skillNoDoc.title.one', 'setup.check.skillNoDoc.title.other'],
    detail: 'setup.check.skillNoDoc.detail',
    value: 'setup.check.linksTo',
  },
  skillNoDescription: {
    title: ['setup.check.skillNoDescription.title.one', 'setup.check.skillNoDescription.title.other'],
    detail: 'setup.check.skillNoDescription.detail',
  },
  skillLongName: {
    title: ['setup.check.skillLongName.title.one', 'setup.check.skillLongName.title.other'],
    detail: 'setup.check.skillLongName.detail',
  },
  skillNameMismatch: {
    title: ['setup.check.skillNameMismatch.title.one', 'setup.check.skillNameMismatch.title.other'],
    detail: { claude: 'setup.check.skillNameMismatch.detail.claude', codex: 'setup.check.skillNameMismatch.detail.codex' },
    value: 'setup.check.named',
  },
  skillDuplicate: { title: 'setup.check.skillDuplicate.title', detail: 'setup.check.skillDuplicate.detail', value: 'setup.check.named' },
  skillDrifted: {
    title: ['setup.check.skillDrifted.title.one', 'setup.check.skillDrifted.title.other'],
    detail: 'setup.check.skillDrifted.detail',
  },
  codexUnsupported: {
    title: ['setup.check.codexUnsupported.title.one', 'setup.check.codexUnsupported.title.other'],
    detail: 'setup.check.codexUnsupported.detail',
  },
  codexDeprecated: {
    title: ['setup.check.codexDeprecated.title.one', 'setup.check.codexDeprecated.title.other'],
    detail: 'setup.check.codexDeprecated.detail',
  },
  codexSkillsFolder: {
    title: ['setup.check.codexSkillsFolder.title.one', 'setup.check.codexSkillsFolder.title.other'],
    detail: 'setup.check.codexSkillsFolder.detail',
  },
  overridesIgnored: { title: 'setup.check.overridesIgnored.title', detail: 'setup.check.overridesIgnored.detail' },
  noSkills: { title: 'setup.check.noSkills.title', detail: ['setup.check.noSkills.detail.one', 'setup.check.noSkills.detail.other'] },
  listingBudget: { title: 'setup.check.listingBudget.title', detail: 'setup.check.listingBudget.detail' },
  toolSearchOff: { title: 'setup.check.toolSearchOff.title', detail: 'setup.check.toolSearchOff.detail' },
  policySets: { title: ['setup.check.policySets.title.one', 'setup.check.policySets.title.other'], detail: 'setup.check.policySets.detail' },
  duplicateInstall: { title: 'setup.check.duplicateInstall.title', detail: 'setup.check.duplicateInstall.detail' },
};

/** What takes the place of an old Codex setting, where that's more than a new name. */
const CODEX_INSTEAD: Record<string, MessageKey> = {
  profileFlag: 'setup.check.codex.profileFlag',
  untrusted: 'setup.check.codex.untrusted',
  profileFiles: 'setup.check.codex.profileFiles',
  onFailure: 'setup.check.codex.onFailure',
};

/** The count a check's message is about: the one in its facts, else the things it's about. */
const countOf = (check: SetupCheck) => (typeof check.facts.count === 'number' ? check.facts.count : check.subjects.length);

/** What the agents' setups get wrong across the fleet, most serious first, each leading to what it's about. */
export function SetupChecks({ checks, machines, homeLabel, onShow, onCompare }: {
  checks: SetupCheck[];
  /** The machines scanned, for when there's nothing to say. */
  machines: string[];
  homeLabel: (key: string) => string;
  onShow: (home: string, name: string) => void;
  onCompare: (check: SetupCheck, subject: SetupCheckSubject) => void;
}) {
  const { t, tRich } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const counts = checkCounts(checks);
  const shown = expanded ? checks : checks.slice(0, COLLAPSED);
  const levels = (['problem', 'warning', 'note'] as const).filter((level) => counts[level]);
  return (
    <SettingsSection
      title={(
        <>
          {t('setup.checks.title')}
          {levels.map((level) => (
            <Badge key={level} variant={LEVEL_LOOK[level].badge} size="sm">
              {t(LEVEL_LOOK[level].count[counts[level] === 1 ? 0 : 1], { count: counts[level] })}
            </Badge>
          ))}
        </>
      )}
    >
      {checks.length ? (
        <>
          {shown.map((check) => (
            <CheckRow key={check.id} check={check} homeLabel={homeLabel} onShow={onShow} onCompare={onCompare} />
          ))}
          {checks.length > COLLAPSED ? (
            <button
              type="button"
              className="w-full px-4 py-2 text-center text-xs text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? t('setup.checks.fewer') : t('setup.checks.all', { count: checks.length })}
            </button>
          ) : null}
        </>
      ) : (
        <div className="flex items-center gap-3 px-4 py-3 text-xs text-muted-foreground">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success-foreground" />
          <span>
            {machines.length === 1
              ? tRich('setup.checks.noneOne', { machine: <MachinePill name={machines[0]} size="sm" /> })
              : t('setup.checks.none', { count: machines.length })}
          </span>
        </div>
      )}
    </SettingsSection>
  );
}

function CheckRow({ check, homeLabel, onShow, onCompare }: {
  check: SetupCheck;
  homeLabel: (key: string) => string;
  onShow: (home: string, name: string) => void;
  onCompare: (check: SetupCheck, subject: SetupCheckSubject) => void;
}) {
  const { t } = useI18n();
  const look = LEVEL_LOOK[check.level];
  const Icon = look.icon;
  const message = MESSAGE[check.kind];
  const count = countOf(check);
  const values = Object.fromEntries(
    Object.entries({ ...check.facts, count }).map(([name, value]) => [name, typeof value === 'number' ? formatNumber(value, 3) : value]),
  );
  const pick = (key: MessageKey | Plural | Record<'claude' | 'codex', MessageKey>): MessageKey => {
    if (Array.isArray(key)) return key[count === 1 ? 0 : 1];
    if (typeof key === 'object') return key[check.facts.agentId === 'codex' ? 'codex' : 'claude'];
    return key;
  };
  const title = t(pick(message.title), values);
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background dark:bg-input/32 [&_svg]:size-3.5', look.className)}>
        <Icon aria-hidden="true" />
        <span className="sr-only">{t(look.label)}</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="min-w-0 text-sm font-medium text-foreground">{title}</span>
          <MetaLine
            className="ms-auto shrink-0 text-xs"
            parts={[<MachinePill key="machine" name={check.machine} size="sm" className="shrink-0" />, check.home ? homeLabel(check.home) : null]}
          />
        </div>
        <p className="mt-0.5 text-xs leading-[1.45] text-muted-foreground">{t(pick(message.detail), values)}</p>
        {check.facts.error ? <p className="mt-1 break-all font-mono text-2xs text-muted-foreground">{check.facts.error}</p> : null}
        {check.kind === 'sessionCleanup' ? <KeepSessions check={check} homeName={check.home ? homeLabel(check.home) : null} /> : null}
        {check.subjects.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {check.subjects.map((subject, index) => (
              <SubjectChip
                key={`${subject.home ?? ''}:${subject.name}`}
                check={check}
                subject={subject}
                runs={check.kind === 'duplicateInstall' && index === 0}
                elsewhere={subject.home !== null && subject.home !== check.home ? homeLabel(subject.home) : null}
                onShow={onShow}
                onCompare={onCompare}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Sets cleanupPeriodDays in the home so Claude Code stops deleting its sessions. The machine is
 * scanned again afterward, which takes the check away.
 */
function KeepSessions({ check, homeName }: { check: SetupCheck; homeName: string | null }) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const home = String(check.facts.home ?? '');
  const keep = async () => {
    const confirmed = await askConfirmation({
      title: t('setup.check.sessionCleanup.confirm.title'),
      message: t('setup.check.sessionCleanup.confirm.message', { days: formatNumber(KEEP_DAYS), file: `${home}/settings.json` }),
      confirmText: t('setup.check.sessionCleanup.keep'),
      details: [{
        label: t('setup.check.sessionCleanup.confirm.where'),
        value: (
          <span className="inline-flex items-center gap-1.5">
            <MachinePill name={check.machine} size="sm" />
            {homeName}
          </span>
        ),
      }],
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const [edit] = await keepClaudeSessions(check.machine, [home]);
      if (edit?.error) setError(edit.error);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void keep()}>
        {busy ? <Spinner /> : null}
        {t('setup.check.sessionCleanup.keep')}
      </Button>
      {error ? <span className="text-xs text-error-foreground">{t('setup.check.sessionCleanup.failed', { error })}</span> : null}
    </div>
  );
}

/** A thing a check is about. It opens its row in the table, or its two copies side by side. */
function SubjectChip({ check, subject, runs, elsewhere, onShow, onCompare }: {
  check: SetupCheck;
  subject: SetupCheckSubject;
  /** The install that runs, of an agent installed more than once. */
  runs: boolean;
  /** The home it's in, when that isn't the check's. */
  elsewhere: string | null;
  onShow: (home: string, name: string) => void;
  onCompare: (check: SetupCheck, subject: SetupCheckSubject) => void;
}) {
  const { t } = useI18n();
  const valueKey = MESSAGE[check.kind].value;
  let value: string | null = null;
  if (check.kind === 'duplicateInstall') value = subject.value ?? t('setup.check.duplicateInstall.noVersion');
  else if (check.kind === 'codexUnsupported' || check.kind === 'codexDeprecated') {
    const instead = subject.value ?? '';
    value = CODEX_INSTEAD[instead] ? t(CODEX_INSTEAD[instead]) : t('setup.check.codex.renamed', { value: instead });
  } else if (subject.value !== null && valueKey) value = t(valueKey, { value: subject.value });
  const content = (
    <>
      <span className="min-w-0 truncate font-mono text-foreground">{subject.name}</span>
      {value ? <span className="min-w-0 truncate text-muted-foreground">{value}</span> : null}
      {elsewhere ? <span className="min-w-0 truncate text-muted-foreground">{t('setup.check.inHome', { home: elsewhere })}</span> : null}
      {runs ? <Badge variant="success" size="sm">{t('setup.check.duplicateInstall.runs')}</Badge> : null}
    </>
  );
  const className = 'inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-0.5 text-xs dark:bg-input/32';
  const action = subject.pair
    ? { run: () => onCompare(check, subject), label: t('setup.checks.compare', { name: subject.name }) }
    : subject.home
      ? { run: () => onShow(subject.home!, subject.name), label: t('setup.checks.show', { name: subject.name }) }
      : null;
  if (!action) return <span className={className}>{content}</span>;
  return (
    <button
      type="button"
      className={cn(className, 'cursor-pointer outline-none transition-colors hover:border-border hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring')}
      onClick={action.run}
      title={action.label}
    >
      {content}
    </button>
  );
}
