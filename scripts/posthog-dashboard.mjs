// Builds the "Arbor" dashboard in Arbor's PostHog project from the events the app sends (product_analytics.rs):
// launches, versions, pages, features, alerts, errors and slow or failing calls.
//
//   bun scripts/posthog-dashboard.mjs            creates it, or stops if it's already there
//   bun scripts/posthog-dashboard.mjs --replace  deletes the one there and creates it again
//
// Needs a personal API key with dashboard write and insight write, as POSTHOG_CLI_API_KEY in .env (bun loads it),
// the same key the release build sends source maps with.
const HOST = process.env.POSTHOG_CLI_HOST || 'https://us.posthog.com';
const PROJECT = process.env.POSTHOG_CLI_PROJECT_ID || '632085';
const KEY = process.env.POSTHOG_CLI_API_KEY;
const NAME = 'Arbor';

if (!KEY) {
  console.error('Set POSTHOG_CLI_API_KEY in .env to a personal API key with dashboard write and insight write.');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const url = (path) => `${HOST}/api/projects/${PROJECT}${path}`;

async function read(response, what) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const get = async (path) => read(await fetch(url(path), { headers }), `GET ${path}`);
// send is only ever PATCH or POST; reads go through get.
// oxlint-disable-next-line unicorn/no-invalid-fetch-options
const send = async (method, path, body) => read(await fetch(url(path), { method, headers, body: JSON.stringify(body) }), `${method} ${path}`);

const series = (event, math = 'total', properties = []) => ({ kind: 'EventsNode', event, name: event, math, properties });
const where = (key, value) => ({ key, value, operator: 'exact', type: 'event' });
const trends = ({ series: list, breakdown, display = 'ActionsLineGraph', from = '-30d', interval = 'day' }) => ({
  kind: 'InsightVizNode',
  source: {
    kind: 'TrendsQuery',
    series: list,
    interval,
    dateRange: { date_from: from },
    ...(breakdown ? { breakdownFilter: { breakdown, breakdown_type: 'event', breakdown_limit: 25 } } : {}),
    trendsFilter: { display },
  },
});

const INSIGHTS = [
  { name: 'Launches and Macs', description: 'Launches a day, and how many installs launched.', query: trends({ series: [series('app.launched'), series('app.launched', 'dau')] }) },
  { name: 'Versions in use', description: 'Launches by Arbor version, last 14 days.', query: trends({ series: [series('app.launched', 'dau')], breakdown: 'app_version', from: '-14d', display: 'ActionsBarValue' }) },
  { name: 'Pages opened', description: 'Page views by page, last 30 days.', query: trends({ series: [series('page.viewed')], breakdown: 'page', display: 'ActionsBarValue' }) },
  { name: 'Page views by view', description: 'Views within a page (Usage › Digest, Sync › Skills…).', query: trends({ series: [series('page.viewed')], breakdown: 'tab', display: 'ActionsBarValue' }) },
  { name: 'Features used', description: 'feature.used by feature, last 30 days.', query: trends({ series: [series('feature.used')], breakdown: 'feature', display: 'ActionsBarValue' }) },
  { name: 'Features over time', description: 'feature.used a day, by feature.', query: trends({ series: [series('feature.used')], breakdown: 'feature' }) },
  { name: 'Alerts sent', description: 'Alerts by kind, last 30 days.', query: trends({ series: [series('feature.used', 'total', [where('feature', 'alert-sent')])], breakdown: 'kind', display: 'ActionsBarValue' }) },
  { name: 'Search palette picks', description: 'What the palette was used to open.', query: trends({ series: [series('feature.used', 'total', [where('feature', 'palette-used')])], breakdown: 'kind', display: 'ActionsPie' }) },
  { name: 'Errors', description: 'Exceptions a day, by where they were caught.', query: trends({ series: [series('$exception')], breakdown: 'source' }) },
  { name: 'Errors by version', description: 'Exceptions by the version that raised them, last 14 days.', query: trends({ series: [series('$exception')], breakdown: 'app_version', from: '-14d', display: 'ActionsBarValue' }) },
  { name: 'Failing and slow calls', description: 'call.problem by operation: machine scripts and core requests that failed, timed out or were slow (at most one per operation an hour).', query: trends({ series: [series('call.problem')], breakdown: 'operation', display: 'ActionsBarValue' }) },
  { name: 'Call problems by outcome', description: 'call.problem a day by outcome.', query: trends({ series: [series('call.problem')], breakdown: 'outcome' }) },
];

const existing = (await get(`/dashboards/?search=${encodeURIComponent(NAME)}&limit=100`)).results.filter((board) => board.name === NAME && !board.deleted);
if (existing.length) {
  if (!process.argv.includes('--replace')) {
    console.log(`The "${NAME}" dashboard is already there (${HOST}/project/${PROJECT}/dashboard/${existing[0].id}); --replace builds it again.`);
    process.exit(0);
  }
  for (const board of existing) await send('PATCH', `/dashboards/${board.id}/`, { deleted: true, delete_insights: true });
}

const dashboard = await send('POST', '/dashboards/', { name: NAME, description: 'How Arbor is used and where it breaks, from the app\'s own usage data.', pinned: true });
for (const insight of INSIGHTS) {
  await send('POST', '/insights/', { ...insight, dashboards: [dashboard.id], saved: true });
  console.log(`Added ${insight.name}`);
}
console.log(`${HOST}/project/${PROJECT}/dashboard/${dashboard.id}`);
