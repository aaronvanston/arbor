import { Check, Copy } from './ui/icons';
import { useI18n } from '../i18n';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { Button } from './ui/button';

/** A command to run on the machine, with a button that copies it. Arbor doesn't run these itself. */
export function CommandLine({ command }: { command: string }) {
  const { t } = useI18n();
  const { copy, copied: copiedText } = useCopyToClipboard({ inline: true });
  const copied = copiedText === command;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-muted/30 py-1 ps-3 pe-1 dark:bg-input/16">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={command}>{command}</code>
      <Button variant="ghost-muted" size="icon-xs" onClick={() => void copy(command)} aria-label={t('setup.checklist.copy')} title={t(copied ? 'setup.checklist.copied' : 'setup.checklist.copy')}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
