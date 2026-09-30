import { Inbox } from '../components/ui/icons';
import { useNothingRecorded } from '../hooks/useCollectorStatus';
import { useI18n } from '../i18n';
import { Empty, EmptyDescription, EmptyMedia } from '../components/ui/empty';

export function UsageEmpty() {
  const { t } = useI18n();
  const nothingYet = useNothingRecorded();
  return (
    <Empty size="sm">
      <EmptyMedia><Inbox /></EmptyMedia>
      <EmptyDescription>{t(nothingYet ? 'usage.emptyYet' : 'usage.empty')}</EmptyDescription>
    </Empty>
  );
}
