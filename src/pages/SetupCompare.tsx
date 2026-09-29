import { useEffect, useState } from 'react';
import { ChangesHeader, FileChanges, FileViewToggle, type CopyLabels } from '../components/FileChanges';
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Badge } from '../components/ui/badge';
import { Spinner } from '../components/ui/spinner';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { canPreview, type FileView } from '../services/fileView';
import { formatBytes } from '../services/machineHealth';
import {
  compareSkillFiles,
  readSetupSkill,
  readSetupText,
  type SetupItemKind,
  type SkillFileChange,
} from '../services/setupInventory';
import type { SetupItem, SetupSkillFile } from '../native/types';
import { machineName } from '../services/machineNames';
import { MachinePill } from '../components/identity/Identity';

type TranslateRich = ReturnType<typeof useI18n>['tRich'];

/**
 * One thing in two places: the reference machine's copy and another's, or two homes' copies on one
 * machine, each named by its `label`. Either may be missing.
 */
export type ComparisonSide = { machine: string; item: SetupItem | null; label?: string };
export type Comparison = {
  kind: SetupItemKind;
  name: string;
  reference: ComparisonSide;
  other: ComparisonSide;
};

const HIDDEN_REASON: Record<NonNullable<SetupSkillFile['hidden']>, MessageKey> = {
  secret: 'setup.compare.hidden.secret',
  large: 'setup.compare.hidden.large',
  binary: 'setup.compare.hidden.binary',
};

/** The line-by-line differences between two machines' copies of a file or skill, read from each when it opens. */
export function SetupCompareDialog({ comparison, onClose }: { comparison: Comparison | null; onClose: () => void }) {
  const { tRich } = useI18n();
  return (
    <Dialog open={comparison !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="max-w-4xl">
        {comparison ? (
          <>
            <DialogHeader>
              <DialogTitle className="truncate pe-8 font-mono text-base">{comparison.name}</DialogTitle>
              <DialogDescription>
                {comparison.reference.machine === comparison.other.machine
                  ? tRich('setup.compare.descriptionCopies', {
                    one: sideName(comparison.reference),
                    other: sideName(comparison.other),
                    machine: <MachinePill name={comparison.other.machine} />,
                  })
                  : tRich('setup.compare.description', {
                    reference: <MachinePill name={comparison.reference.machine} />,
                    machine: <MachinePill name={comparison.other.machine} />,
                  })}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-3">
              {comparison.kind === 'skill' ? <SkillComparison comparison={comparison} /> : <TextComparison comparison={comparison} />}
            </DialogPanel>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

const sideName = (side: ComparisonSide) => side.label ?? machineName(side.machine);

type Loaded<T> = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; before: T; after: T };

/** Reads both sides whenever the comparison changes, dropping what an earlier one sent back. */
function useBothSides<T>(comparison: Comparison, read: (machine: string, item: SetupItem) => Promise<T>, empty: T): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: 'loading' });
  useEffect(() => {
    let current = true;
    setLoaded({ state: 'loading' });
    const side = ({ machine, item }: ComparisonSide) => (item ? read(machine, item) : Promise.resolve(empty));
    Promise.all([side(comparison.reference), side(comparison.other)])
      .then(([before, after]) => { if (current) setLoaded({ state: 'ready', before, after }); })
      .catch((error) => { if (current) setLoaded({ state: 'error', error: String(error) }); });
    return () => { current = false; };
    // `read` and `empty` are fixed for each kind of comparison.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparison]);
  return loaded;
}

function Loading() {
  const { t } = useI18n();
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Spinner />
      {t('setup.compare.loading')}
    </p>
  );
}

function Failed({ error }: { error: string }) {
  const { t } = useI18n();
  return <p className="py-4 text-sm text-error-foreground">{t('setup.compare.failed', { error })}</p>;
}

const readText = (machine: string, item: SetupItem) => readSetupText(machine, item.path ?? '');
const NO_TEXT = { content: '', size: 0 };

/** What a side is called over its copy: its home, or its machine's pill, or that it hasn't one. */
const sideLabel = (side: ComparisonSide, tRich: TranslateRich) => {
  const name = side.label ?? <MachinePill name={side.machine} size="sm" />;
  return side.item ? name : tRich('setup.compare.notOn', { machine: name });
};

/** Both sides' labels, for the header over the changes and over each rendered copy. */
const sideLabels = ({ reference, other }: Comparison, tRich: TranslateRich): CopyLabels =>
  ({ before: sideLabel(reference, tRich), after: sideLabel(other, tRich) });

function TextComparison({ comparison }: { comparison: Comparison }) {
  const { t, tRich } = useI18n();
  const [view, setView] = useState<FileView>('source');
  const loaded = useBothSides(comparison, readText, NO_TEXT);
  if (loaded.state === 'loading') return <Loading />;
  if (loaded.state === 'error') return <Failed error={loaded.error} />;
  const unreadable = [loaded.before, loaded.after].find((side) => side.content === null);
  if (unreadable) {
    return <p className="py-4 text-sm text-muted-foreground">{t('setup.compare.tooLarge', { size: formatBytes(unreadable.size) })}</p>;
  }
  const labels = sideLabels(comparison, tRich);
  // The path names the file's type, for highlighting and whether it can be previewed.
  const path = comparison.other.item?.path ?? comparison.reference.item?.path ?? comparison.name;
  return (
    <>
      <ChangesHeader {...labels} path={path} view={view} onView={setView} />
      <FileChanges
        path={path}
        before={comparison.reference.item ? loaded.before.content ?? '' : null}
        after={comparison.other.item ? loaded.after.content ?? '' : null}
        labels={labels}
        view={view}
      />
    </>
  );
}

const readSkill = (machine: string, item: SetupItem) => readSetupSkill(machine, item.path ?? '');
const NO_FILES: SetupSkillFile[] = [];

const CHANGE_LOOK: Record<SkillFileChange['state'], { key: MessageKey; variant: 'warning' | 'success' | 'error' | 'muted' }> = {
  changed: { key: 'setup.compare.file.changed', variant: 'warning' },
  added: { key: 'setup.compare.file.added', variant: 'success' },
  removed: { key: 'setup.compare.file.removed', variant: 'error' },
  same: { key: 'setup.compare.file.same', variant: 'muted' },
};

function SkillComparison({ comparison }: { comparison: Comparison }) {
  const { tRich } = useI18n();
  const loaded = useBothSides(comparison, readSkill, NO_FILES);
  if (loaded.state === 'loading') return <Loading />;
  if (loaded.state === 'error') return <Failed error={loaded.error} />;
  const labels = sideLabels(comparison, tRich);
  return (
    <>
      <ChangesHeader {...labels} />
      <SkillFilesDiff before={loaded.before} after={loaded.after} labels={labels} />
    </>
  );
}

/** Two copies of a skill, file by file: each file that differs with its changes, then how many match. */
export function SkillFilesDiff({ before, after, labels }: {
  before: SetupSkillFile[];
  after: SetupSkillFile[];
  /** What each copy is called over it when previewed. */
  labels: CopyLabels;
}) {
  const { t } = useI18n();
  const changes = compareSkillFiles(before, after);
  const differing = changes.filter((change) => change.state !== 'same');
  const matching = changes.length - differing.length;
  return (
    <>
      {differing.map((change) => <SkillFileChanges key={change.path} change={change} labels={labels} />)}
      {matching ? (
        <p className="text-xs text-muted-foreground">{t(matching === 1 ? 'setup.compare.matching.one' : 'setup.compare.matching.other', { count: matching })}</p>
      ) : null}
      {!differing.length ? <p className="text-sm text-muted-foreground">{t('setup.compare.skillMatches')}</p> : null}
    </>
  );
}

/** One file of a skill that differs: its changes, or with SKILL.md, the rendered copies when asked. */
function SkillFileChanges({ change, labels }: { change: SkillFileChange; labels: CopyLabels }) {
  const { t } = useI18n();
  const [view, setView] = useState<FileView>('source');
  const look = CHANGE_LOOK[change.state];
  // A file one side can't show is left out on both.
  const hidden = change.after?.hidden ?? change.before?.hidden ?? null;
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <MiddleTruncate value={change.path} className="font-mono text-xs text-foreground" />
        <Badge variant={look.variant} size="sm">{t(look.key)}</Badge>
        {!hidden && canPreview(change.path) ? (
          <div className="ms-auto">
            <FileViewToggle value={view} onChange={setView} />
          </div>
        ) : null}
      </div>
      {hidden ? (
        <p className="text-xs text-muted-foreground">{t(HIDDEN_REASON[hidden])}</p>
      ) : (
        <FileChanges
          path={change.path}
          before={change.before ? change.before.content ?? '' : null}
          after={change.after ? change.after.content ?? '' : null}
          labels={labels}
          view={view}
        />
      )}
    </section>
  );
}
