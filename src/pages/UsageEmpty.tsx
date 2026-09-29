import { Inbox } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { Empty, EmptyDescription, EmptyMedia } from '../components/ui/empty';

export function UsageEmpty() {
  const { t } = useI18n();
  return (
    <Empty size="sm">
      <EmptyMedia><Inbox /></EmptyMedia>
      <EmptyDescription>{t('usage.empty')}</EmptyDescription>
    </Empty>
  );
}
