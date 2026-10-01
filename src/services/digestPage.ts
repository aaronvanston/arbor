import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatCount, formatDate, formatDateWith, formatMoney, formatNumber, formatUnpriced } from '../lib/format';
import { EXPIRING_MIN_PERCENT } from './expiringCapacity';
import { providerLabel } from './providerLimits';
import { sessionClient, sessionPlace, shortSessionId } from './usageSessions';
import {
  cacheMissCost,
  change,
  DIGEST_PULL_REQUESTS,
  formatRatio,
  LIMIT_WARNING_PERCENT,
  mergedHint,
  noMergedText,
  percentText,
  SAME_CHANGE,
  spendKnown,
  weekDays,
  type DigestWeek,
  type WeeklyDigest,
} from './weeklyDigest';
import type { UsageSession } from '../native/types';
import { machineName } from './machineNames';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** Markup that's safe to put in the page as it is. */
class Html {
  constructor(readonly html: string) {}
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

function toHtml(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(toHtml).join('');
  if (value instanceof Html) return value.html;
  return escapeHtml(String(value));
}

/** A piece of the page. Whatever goes into it is escaped, other pieces aside. */
function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  return new Html(strings.reduce((out, part, index) => out + part + (index < values.length ? toHtml(values[index]) : ''), ''));
}

/** Only web links go in the page. */
const webUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : null);

// Arbor's own colors: zinc grays, its teal, and the status colors, light and dark.
const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--fg:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:oklch(0.5 0.1 180);--good:#047857;--bad:#b91c1c;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--card:#161616;--fg:#f4f4f5;--muted:#a1a1aa;--border:#27272a;--accent:oklch(0.76 0.12 172);--good:#34d399;--bad:#f87171;--warn:#fbbf24}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:880px;margin:0 auto;padding:48px 24px 64px}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}
.kicker{font-size:12px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
h1{margin:6px 0 2px;font-size:28px;font-weight:650;letter-spacing:-.02em}
.compared{margin:0;color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:28px;border:1px solid var(--border);border-radius:14px;background:var(--card);overflow:hidden}
.stat{padding:14px 16px;min-width:0}.stat+.stat{border-left:1px solid var(--border)}
.stat .label{font-size:12px;color:var(--muted)}
.stat .value{margin:2px 0;font-size:22px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;white-space:nowrap}
.stat .hint{font-size:12px;color:var(--muted)}
section{margin-top:32px}
h2{margin:0 0 2px;font-size:15px;font-weight:600}
.description{margin:0 0 10px;font-size:13px;color:var(--muted)}
.card{border:1px solid var(--border);border-radius:14px;background:var(--card);overflow:hidden}
.row{display:flex;align-items:center;gap:12px;padding:10px 16px;min-height:56px}.row+.row,.row+.note,.note+.row{border-top:1px solid var(--border)}
.main{flex:1;min-width:0}
.title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.detail{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.figure{flex-shrink:0;min-width:84px;text-align:right;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.figure.wide{min-width:112px}
.share{flex-shrink:0;min-width:84px;text-align:right;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.muted{color:var(--muted)}
.added{color:var(--good)}.removed{color:var(--bad)}
.lines{white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.change{margin-left:8px;font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--muted)}.change.good{color:var(--good)}.change.bad{color:var(--warn)}
.note{padding:10px 16px;font-size:13px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:8px 16px;font-size:12px;font-weight:500;color:var(--muted);text-align:left;border-bottom:1px solid var(--border)}
td{padding:8px 16px;vertical-align:middle}tr+tr td{border-top:1px solid var(--border)}
.num{text-align:right;white-space:nowrap}td.num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.use{flex-shrink:0;width:176px}
.bar{height:6px;border-radius:999px;background:var(--border);overflow:hidden}.bar>span{display:block;height:100%;background:var(--accent)}.bar.warn>span{background:var(--warn)}
.use .detail{margin-top:6px}
footer{margin-top:40px;font-size:12px;color:var(--muted)}
@media (max-width:680px){main{padding:32px 16px 48px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat:nth-child(3){border-left:0}.stat:nth-child(n+3){border-top:1px solid var(--border)}.row{gap:10px;padding:10px 14px}th,td{padding:8px 14px}.use{width:104px}.figure,.figure.wide{min-width:0}.extra,.share,th:nth-child(3),td:nth-child(3),th:nth-child(4),td:nth-child(4){display:none}}
@media print{body{background:#fff}main{padding:0}.card,.stats{break-inside:avoid}}
`;

/** The page's file name: the week's Monday, like `arbor-week-2026-09-21.html`. */
export function digestFileName(week: DigestWeek) {
  const start = new Date(week.startMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `arbor-week-${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}.html`;
}

/** A session as the digest names it: its title or client, then where it ran. */
function sessionText(session: UsageSession, t: Translate) {
  const client = sessionClient(session.userAgent);
  const name = client ? [client.name, client.version].filter(Boolean).join(' ') : t('usage.sessions.unknownClient');
  const place = sessionPlace(session.transcript);
  const where = [
    place ? place.project : shortSessionId(session.id),
    place?.branch && place.branch !== place.project ? place.branch : '',
    machineName(session.machine || session.transcript?.machine || ''),
  ].filter(Boolean).join(' · ');
  return { title: session.transcript?.title || [name, client?.host].filter(Boolean).join(' · '), where };
}

/**
 * The week's digest as a page that stands on its own: one file, its styles inside, nothing loaded from anywhere,
 * light or dark with the reader's system. It holds what the Weekly tab shows, names included.
 */
export function digestPage(digest: WeeklyDigest, { t, nowMs }: { t: Translate; nowMs: number }): string {
  const number = formatCount;
  const money = formatMoney;
  const soFar = digest.week.offset === 0;
  // The year is said on its own, so the days only carry one when the week runs over New Year.
  const days = weekDays(digest.week, digest.week.endMs - 1);
  const year = new Date(Math.max(digest.week.startMs, digest.week.endMs - 1)).getFullYear();
  const before = (value: string) => t(soFar ? 'usage.digest.before.soFar' : 'usage.digest.before.week', { value });

  const lines = (added: number, removed: number) =>
    html`<span class="lines"><span class="added">+${number(added)}</span> <span class="removed">−${number(removed)}</span></span>`;
  const none = html`<span class="muted">—</span>`;
  const moved = (current: number, previous: number, better?: 'up' | 'down') => {
    const share = change(current, previous);
    if (share === null || Math.abs(share) < SAME_CHANGE) return null;
    const up = share > 0;
    const tone = better ? ((better === 'up') === up ? 'good' : 'bad') : '';
    return html`<span class="change ${tone}">${up ? '+' : '−'}${formatNumber(Math.round(Math.abs(share) * 100))}%</span>`;
  };
  const stat = (label: string, value: unknown, hint: string) =>
    html`<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;
  const section = (title: string, description: string, body: unknown) =>
    html`<section><h2>${title}</h2><p class="description">${description}</p><div class="card">${body}</div></section>`;
  const row = (title: unknown, detail: unknown, figures: unknown) =>
    html`<div class="row"><div class="main"><div class="title">${title}</div>${detail ? html`<div class="detail">${detail}</div>` : null}</div>${figures}</div>`;
  const note = (text: string) => html`<div class="note">${text}</div>`;

  const stats = html`<div class="stats">${[
    stat(
      t('usage.digest.stat.spend'),
      spendKnown(digest) ? html`${money(digest.cost)}${moved(digest.cost, digest.previousCost)}` : formatUnpriced(),
      spendKnown(digest) ? before(money(digest.previousCost)) : t('usage.digest.stat.noPrices'),
    ),
    stat(t('usage.digest.stat.sessions'), html`${number(digest.sessions)}${moved(digest.sessions, digest.previousSessions)}`, before(number(digest.previousSessions))),
    stat(t('usage.digest.stat.merged'), number(digest.merged.length), mergedHint(digest, t)),
    stat(
      t('usage.digest.stat.lines'),
      digest.sessionsWithLines ? lines(digest.linesAdded, digest.linesRemoved) : '—',
      digest.sessionsWithLines
        ? t(digest.sessionsWithLines === 1 ? 'usage.projects.stat.linesHint.one' : 'usage.projects.stat.linesHint.other', { count: number(digest.sessionsWithLines) })
        : t('usage.projects.stat.noLines'),
    ),
  ]}</div>`;

  const merged = digest.merged.slice(0, DIGEST_PULL_REQUESTS);
  const moreMerged = digest.merged.length - merged.length;
  const done = section(t('usage.digest.done.title'), t('usage.digest.done.description'), merged.length
    ? [
        merged.map((pullRequest) => {
          const name = `${pullRequest.repository}#${pullRequest.number}`;
          const title = pullRequest.github?.title || name;
          const url = webUrl(pullRequest.url);
          const day = formatDate(pullRequest.github!.mergedAtMs!, { weekday: 'short', now: nowMs });
          return row(
            url ? html`<a href="${url}">${title}</a>` : title,
            html`<span class="mono">${name}</span> · ${pullRequest.project} · ${t('usage.digest.done.mergedOn', { day })}`,
            html`<div class="figure wide extra">${pullRequest.linesAdded || pullRequest.linesRemoved ? lines(pullRequest.linesAdded, pullRequest.linesRemoved) : none}</div><div class="figure">${money(pullRequest.pricedRequests ? pullRequest.estimatedCost : null)}</div>`,
          );
        }),
        moreMerged > 0 ? note(t(moreMerged === 1 ? 'usage.digest.done.more.one' : 'usage.digest.done.more.other', { count: number(moreMerged) })) : null,
      ]
    : note(noMergedText(digest, t)));

  const projects = section(t('usage.digest.projects.title'), t('usage.digest.projects.description'), digest.projects.length
    ? [
        html`<table><thead><tr><th>${t('usage.projects.column.project')}</th><th class="num">${t('usage.projects.column.sessions')}</th><th class="num">${t('usage.digest.projects.column.merged')}</th><th class="num">${t('usage.projects.column.lines')}</th><th class="num">${t('usage.projects.column.cost')}</th></tr></thead><tbody>${digest.projects.map((project) => html`<tr><td><div class="title">${project.name}</div>${project.repository ? html`<div class="detail">${project.repository}</div>` : null}</td><td class="num">${number(project.sessions)}</td><td class="num">${project.merged ? number(project.merged) : none}</td><td class="num">${project.sessionsWithLines ? lines(project.linesAdded, project.linesRemoved) : none}</td><td class="num">${money(project.pricedRequests ? project.estimatedCost : null)}</td></tr>`)}</tbody></table>`,
        digest.moreProjects
          ? note(t(digest.moreProjects === 1 ? 'usage.digest.projects.more.one' : 'usage.digest.projects.more.other', { count: number(digest.moreProjects) }))
          : null,
      ]
    : note(t('usage.digest.projects.empty')));

  const sessions = digest.costliest.length
    ? section(t('usage.digest.sessions.title'), t('usage.digest.sessions.description'), digest.costliest.map((session) => {
        const { title, where } = sessionText(session, t);
        // A session's cost in the week is part of the week's; past 100%, the two totals disagree.
        const share = digest.cost > 0 && session.estimatedCost <= digest.cost ? session.estimatedCost / digest.cost : null;
        return row(title, where, html`${share !== null ? html`<div class="share">${t('usage.digest.sessions.share', { percent: percentText(share) })}</div>` : null}<div class="figure">${money(session.estimatedCost)}</div>`);
      }))
    : null;

  const limits = section(t('usage.digest.limits.title'), t('usage.digest.limits.description'), digest.limits.length
    ? digest.limits.map((limit) => {
        const accounts = limit.measured === limit.accounts
          ? t(limit.accounts === 1 ? 'usage.digest.limits.accounts.one' : 'usage.digest.limits.accounts.other', { count: limit.accounts })
          : t('usage.digest.limits.measured', { measured: limit.measured, count: limit.accounts });
        const percent = limit.percent === null ? 0 : Math.min(100, Math.max(0, limit.percent));
        const warn = limit.percent !== null && limit.percent >= LIMIT_WARNING_PERCENT;
        return row(
          providerLabel[limit.provider],
          [limit.window, accounts, limit.spare.length ? t('usage.digest.limits.spare', { names: limit.spare.join(', ') }) : ''].filter(Boolean).join(' · '),
          html`<div class="use"><div class="bar${warn ? ' warn' : ''}"><span style="width:${percent.toFixed(1)}%"></span></div><div class="detail">${limit.percent === null ? t('usage.digest.limits.notYet') : t('usage.digest.limits.used', { percent: Math.round(limit.percent) })}</div></div><div class="figure">${limit.ratio === null ? '—' : t('usage.digest.limits.ratio', { ratio: formatRatio(limit.ratio) })}</div>`,
        );
      })
    : note(t('usage.digest.limits.empty')));

  const { cacheMisses, previousCacheMisses, unused } = digest;
  const waste = section(t('usage.digest.waste.title'), t('usage.digest.waste.description'), [
    row(
      t('usage.digest.waste.cacheMisses'),
      cacheMisses.requests
        ? t(cacheMisses.requests === 1 ? 'usage.digest.waste.cacheMissesDetail.one' : 'usage.digest.waste.cacheMissesDetail.other', {
            count: number(cacheMisses.requests),
            tokens: number(cacheMisses.tokens),
          })
        : t('usage.digest.waste.noCacheMisses'),
      html`<div class="figure wide">${cacheMisses.requests
        ? html`${money(cacheMissCost(cacheMisses))}${cacheMisses.pricedRequests && previousCacheMisses.pricedRequests ? moved(cacheMisses.cost, previousCacheMisses.cost, 'down') : null}`
        : '—'}</div>`,
    ),
    row(
      t('usage.digest.waste.failures'),
      digest.failures
        ? t(digest.failures === 1 ? 'usage.digest.waste.failuresDetail.one' : 'usage.digest.waste.failuresDetail.other', { count: number(digest.failures) })
        : t('usage.digest.waste.noFailures'),
      html`<div class="figure wide">${digest.failureRate ? html`${percentText(digest.failureRate)}${moved(digest.failureRate, digest.previousFailureRate ?? 0, 'down')}` : '—'}</div>`,
    ),
    row(
      t('usage.digest.waste.unused'),
      unused.length
        ? unused.map((item) => t('usage.digest.waste.unusedItem', { name: item.name, percent: Math.round(item.percent), day: formatDateWith(item.resetAtMs, { weekday: 'short' }) })).join('; ')
        : t('usage.digest.waste.noUnused', { percent: EXPIRING_MIN_PERCENT }),
      html`<div class="figure wide">${unused.length ? number(unused.length) : '—'}</div>`,
    ),
  ]);

  return `<!doctype html>\n${html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${t('digest.page.title', { days, year })}</title><style>${new Html(STYLE)}</style></head><body><main><header><div class="kicker">${t('digest.page.kicker')}</div><h1>${t(soFar ? 'digest.page.headingSoFar' : 'digest.page.heading', { days, year })}</h1><p class="compared">${t(soFar ? 'usage.digest.week.comparedSoFar' : 'usage.digest.week.compared')}</p>${digest.machine ? html`<p class="compared">${t('digest.page.machine', { machine: digest.machine === '__unassigned__' ? t('usage.filter.unassigned') : machineName(digest.machine) })}</p>` : null}</header>${stats}${done}${projects}${sessions}${limits}${waste}<footer>${t('digest.page.footer', { date: formatDate(nowMs, { month: 'long', year: 'always' }) })}</footer></main></body></html>`.html}\n`;
}
