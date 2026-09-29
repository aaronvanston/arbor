import { Fragment, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { ExternalLink, ImageIcon } from './ui/icons';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { externalUrl, openExternalUrl, remarkLiteralHtml, splitFrontMatter, type FrontMatterEntry } from '../services/markdownPreview';

/**
 * A link opens in the browser, never in Arbor's window; one that isn't http or https is just its text. It has no
 * `href`: the webview would follow one into Arbor's window from a middle click or its own menu's Open Link, which no
 * handler here can stop.
 */
function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const { t } = useI18n();
  const url = externalUrl(href);
  if (!url) return <span className="text-foreground underline decoration-dotted decoration-1 underline-offset-2">{children}</span>;
  const open = () => void openExternalUrl(url);
  return (
    <span
      role="link"
      tabIndex={0}
      title={t('markdown.linkTitle', { url })}
      className="cursor-pointer rounded-xs text-primary underline decoration-1 underline-offset-2 outline-none ring-ring hover:decoration-2 focus-visible:ring-2"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        open();
      }}
    >
      {children}
      <ExternalLink className="ms-0.5 inline size-3 align-baseline text-icon-muted" aria-hidden="true" />
    </span>
  );
}

/** Images aren't fetched: the preview reads a file, and loading one would tell its host the file was read. */
function ImagePlaceholder({ alt, src }: { alt?: string; src?: string }) {
  const { t } = useI18n();
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 px-1.5 align-middle text-xs text-muted-foreground"
      title={src ? t('markdown.imageTitle', { url: src }) : undefined}
    >
      <ImageIcon className="size-3 shrink-0 text-icon-muted" aria-hidden="true" />
      <span className="truncate">{alt || t('markdown.image')}</span>
    </span>
  );
}

const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mt-5 mb-2 text-lg font-semibold tracking-title text-foreground first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-base font-semibold tracking-title text-foreground first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1.5 text-sm font-semibold text-foreground first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-semibold text-foreground first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-3 mb-1 text-sm font-medium text-foreground first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-3 mb-1 text-xs font-medium text-muted-foreground first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children, className }) => <ul className={cn('my-2 list-disc ps-5 marker:text-icon-muted', className?.includes('contains-task-list') && 'list-none ps-1')}>{children}</ul>,
  ol: ({ children, start }) => <ol start={start} className="my-2 list-decimal ps-5 marker:text-muted-foreground">{children}</ol>,
  li: ({ children }) => <li className="my-0.5 ps-0.5">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-2 border-s-2 border-border ps-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-4 border-border/70" />,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  img: ({ alt, src }) => <ImagePlaceholder alt={alt} src={typeof src === 'string' ? src : undefined} />,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border border-border/60 bg-muted/60 px-3 py-2 font-mono text-xs leading-5 dark:bg-input/16 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="rounded-sm bg-muted px-1 py-px font-mono text-xs dark:bg-input/24">{children}</code>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children, style }) => <th style={style} className="border border-border/70 bg-muted/60 px-2 py-1 text-start font-medium dark:bg-input/16">{children}</th>,
  td: ({ children, style }) => <td style={style} className="border border-border/70 px-2 py-1 align-top">{children}</td>,
  input: ({ checked }) => <input type="checkbox" checked={checked === true} disabled className="me-1.5 size-3 translate-y-px accent-primary" />,
};

function FrontMatter({ entries }: { entries: FrontMatterEntry[] }) {
  const { t } = useI18n();
  return (
    <dl
      aria-label={t('markdown.frontMatter')}
      className="mb-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs dark:bg-input/10"
    >
      {entries.map((entry, index) => (
        <Fragment key={`${index}:${entry.key}`}>
          <dt className="font-mono text-muted-foreground">{entry.key}</dt>
          <dd className="min-w-0 whitespace-pre-line break-words text-foreground">{entry.value || '—'}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * A markdown file as its readers see it. HTML in it is shown as text and everything else passes rehype-sanitize, so
 * nothing in the file can run, restyle Arbor or reach the network; front matter is a key and value list above it.
 */
export function MarkdownPreview({ source }: { source: string }) {
  const { t } = useI18n();
  const { frontMatter, body } = splitFrontMatter(source);
  const empty = !body.trim() && !frontMatter?.length;
  return (
    <div className="min-w-0 break-words text-sm leading-relaxed text-foreground" data-slot="markdown-preview">
      {frontMatter?.length ? <FrontMatter entries={frontMatter} /> : null}
      {empty ? (
        <p className="text-muted-foreground">{t('markdown.empty')}</p>
      ) : (
        <Markdown remarkPlugins={[remarkGfm, remarkLiteralHtml]} rehypePlugins={[rehypeSanitize]} components={COMPONENTS}>
          {body}
        </Markdown>
      )}
    </div>
  );
}
