import type { TopbarAction } from './layout/page';
import { MenuGroupLabel, MenuRadioGroup, MenuRadioItem } from './ui/menu';
import { Toggle, ToggleGroup } from './ui/toggle-group';
import { useI18n } from '../i18n';
import type { ProjectsLens } from '../navigation';

/** Activity is Projects with no lens. */
type LensChoice = 'activity' | ProjectsLens;
const lensChoice = (lens: ProjectsLens | undefined): LensChoice => lens ?? 'activity';
const lensOf = (choice: unknown): ProjectsLens | undefined | null =>
  choice === 'checkouts' ? 'checkouts' : choice === 'activity' ? undefined : null;

function LensToggle({ lens, onChange }: { lens: ProjectsLens | undefined; onChange: (lens: ProjectsLens | undefined) => void }) {
  const { t } = useI18n();
  return (
    <ToggleGroup
      value={[lensChoice(lens)]}
      aria-label={t('tree.projects.lens')}
      onValueChange={(values) => {
        const next = lensOf(values[0]);
        if (next !== null && next !== lens) onChange(next);
      }}
    >
      <Toggle value="activity">{t('tree.projects.activity')}</Toggle>
      <Toggle value="checkouts">{t('tree.projects.checkouts')}</Toggle>
    </ToggleGroup>
  );
}

function LensMenu({ lens, onChange }: { lens: ProjectsLens | undefined; onChange: (lens: ProjectsLens | undefined) => void }) {
  const { t } = useI18n();
  return (
    <MenuRadioGroup
      value={lensChoice(lens)}
      onValueChange={(value: string) => {
        const next = lensOf(value);
        if (next !== null && next !== lens) onChange(next);
      }}
    >
      <MenuGroupLabel>{t('tree.projects.lens')}</MenuGroupLabel>
      <MenuRadioItem value="activity" closeOnClick>{t('tree.projects.activity')}</MenuRadioItem>
      <MenuRadioItem value="checkouts" closeOnClick>{t('tree.projects.checkouts')}</MenuRadioItem>
    </MenuRadioGroup>
  );
}

/**
 * Sessions › Projects' two ways of looking at the projects, in the top bar of both: their sessions' Activity, or their
 * Checkouts on each machine (Sync's Projects once). It folds into ⋯ as a ticked choice when the bar runs out of room.
 */
export function projectsLensAction(lens: ProjectsLens | undefined, onChange: (lens: ProjectsLens | undefined) => void): TopbarAction {
  return {
    id: 'projects-lens',
    bar: <LensToggle lens={lens} onChange={onChange} />,
    menu: <LensMenu lens={lens} onChange={onChange} />,
  };
}
