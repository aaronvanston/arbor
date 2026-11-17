# Compute

Compute shows cloud sandboxes from a provider the user connects in Settings › Compute with an API key. Rust reads each
connected provider once a minute (`src-tauri/src/compute.rs`, one module per provider in `compute/`), keeps the latest
snapshot in memory, and sends it to the window as `compute-updated`. The window's side is `src/services/compute.ts`,
which only Compute's own chunks import; launch reads `services/computeHint.ts` alone (the providers and the saved hint),
so an install with nothing connected doesn't load the store or its figures.

## Sandboxes are not machines

A sandbox lives minutes or hours, belongs to an account rather than to the user's fleet, and is reached through its
provider's API, not over SSH. Nothing in Compute touches the Machines list, `usage_machine_hosts`, Grove, Sync, host
keys or machine alerts. Making sandboxes machines would put short-lived rows in every fleet view, ask Sync to keep them
in line and alert when they go away, which is what they're for. A sandbox only points at a machine, the one that
started it.

## Read-only, by construction

The `ComputeProvider` trait has no call that changes anything at the provider, and a provider can't make a request of
its own: it's handed a `ComputeGet`, which only sends a GET, only for a path on the provider's own allowlist
(`allows`), and only to its fixed `https` API base (`request_url` refuses a path that would leave it). Adding a call to
a provider means adding its path to that allowlist; anything not on it fails before a request is made. The one action
in the window, "Open in …", opens a fixed dashboard address with the sandbox's id through `open_with_system`.

A key that can only read doesn't get everything, though. Boat answers the process list, the only place a sandbox's CPU
and memory are, only to a key with `exec`, so Settings offers both keys and says what the stronger one is for. What
Arbor can send doesn't change with the key: the allowlist is what keeps it to reads, not the key's scope.

## What never crosses

A provider's answers hold things Arbor must not keep. Boat's process list carries every process's full command line,
secrets typed into it included, so the struct that reads a process binds only counts and times: its CPU and memory
numbers, when it started, and whether Boat's exec started it (`commandId` is bound as `IgnoredAny`, so the id itself
is never held). From those a reading says how many commands are running and when the newest began. The command line,
user and process ids are never bound; serde skips them, and a SECRET test checks a token in `command` and the
`commandId` text appear in no snapshot, history or failure a round returns. The same goes
for a sandbox's addresses, desktop URL, environment, who created it (reduced to `mine`) and its free-text reasons
(each reduced to an enum with an `other` bucket). A failure is a `ComputeFailure` kind; a provider's error body is
never read. The key stays in Rust: the window learns only whether a provider is connected, and what the key can do and
when it expires only where a provider reports them. Boat reports neither, so with Boat both read as unknown and the
window claims nothing about the key.

## What's kept

Nothing about sandboxes goes in usage.db. The snapshot and up to 120 one-minute readings per sandbox are in memory,
dropped when a sandbox leaves the list or its provider is disconnected, so a restart starts the charts empty. Two files
sit beside config.toml (`compute/files.rs`): `compute-secrets.json`, the keys, and `compute-claims.json`, the links.
Both are written like the phone alert secrets, 0600 and atomically under a lock. The keys aren't in the Keychain
because every update re-signs the app and macOS would ask again, stopping the background round until someone answered.
Disconnecting forgets the key and the snapshot but keeps the links.

## Linking a sandbox to what started it

Only by ids Arbor is given, never by reading a sandbox's name. An agent runs
`arbor call link-compute-sandbox provider=… sandboxId=… machine=… session=…` right after it creates one (Settings ›
Compute shows the command; `arbor call unlink-compute-sandbox provider=… sandboxId=…` drops it), or the provider
carries `arbor.machine` and `arbor.session` labels; a link wins over a label, and only a link can be unlinked. A link's
machine is found the way `arbor` finds one, by its name or SSH host however typed, because an agent knows its hostname
and not the name Arbor shows; one that fits two machines is refused, and the name on the list is what's kept. A label's
machine must be exactly a name on the list. The session is matched by exact id against the sessions usage.db records (`usage/compute_lookup.rs`), live by the same
rule as everywhere else. A session Arbor hasn't seen shows as such and never makes a sandbox look forgotten. Teammates'
sandboxes are never linked and never forgotten. A link to a sandbox the list doesn't show yet is kept for a while,
since a provider's list lags a create.

A running sandbox of one's own looks forgotten when its session ended over 30 minutes ago and it won't stop by itself
soon, when it has no auto-stop and has run for hours, or when it has run far past its auto-stop. A busy one never
does, for any of those reasons: an agent waiting on a person's review counts as ended while its dev server or tests
still run. Busy means the newest 15 readings from the last 20 minutes, at least 3 of them, average 5% or more of its
vCPUs. With fewer readings (monitoring off, a key that can't read load, just started) Arbor can't tell, and the rules
apply as they are.

## Alerts are the window's, from Rust's round

Rust reads the providers whether or not the window is open, and the window, which is the background service even when
closed (see [the hidden window](overview.md#the-hidden-window)), turns each snapshot into alerts:
`services/computeAlerts.ts` is a pure function of the snapshot, and `components/ComputeAlerts.tsx` runs it through
`notify()`, like every other alert, so they reach the Mac, the phone and the alert history with the same folding and
preferences. Which problems were alerted is kept in localStorage, so a restart or a background reload doesn't alert
them again. A provider whose round can't judge a problem keeps what was alerted for it: one not read yet since launch
(Rust lists it `ok` with nothing in it until its first round), one not answering, or one whose asking Arbor to slow
down has kept its list from being read for more than a couple of rounds. Otherwise the first real round after a
restart or a blip would alert every lasting problem again. A slow-down over CPU and memory reads alone, with the list
fresh, judges everything: only the busy exception leans on those reads, and it lapses by itself once they're twenty
minutes old. Rust marks a sandbox that busy alone keeps from looking forgotten (`forgottenHeld`), and the window keeps
what was alerted for it while that holds, so one whose CPU hovers at the busy line is said once and not each time it
goes quiet. Anything else that clears the flag ends the alert.

Blocked starts are the last answer the provider gave, and Rust keeps it while a later read fails. `startsBlockedNow`
(`services/compute.ts`) is the one place that decides whether it's still said: not from a provider that isn't
answering or turned the key down, nor from one slowed past `RATE_LIMITED_STALE_MS`. The page's banner, Home's line and the sidebar's dot all
ask it, and the sidebar asks again each minute, since a list goes stale by the clock with no new snapshot.

Home's Compute card shows one problem line per provider on purpose: it's a glance that says where to look, and the
Compute page lists the rest.

## Hidden until connected

With no provider connected, Compute is only Settings › Compute: no sidebar row, Home card, machine line, ⌘K entry,
alert or call at launch or idle, and none of its code loads beyond the gates. Opening Settings › Compute asks Rust once
(`get_compute`) whatever the hint says, so a hint lost while a key is still saved is put back there. The window knows without asking Rust, from a saved hint
(`arbor.compute.connected.v1`) listing the connected providers, written as a connect answers and read synchronously
at launch. Only when it names a provider does the window call `get_compute` and listen for `compute-updated`; every
snapshot corrects the hint, since Rust is the truth. That's why Rust reads the saved keys before the loop starts
rather than in it: a `get_compute` answered before they were read would say nothing is connected and hide Compute
until Settings › Compute was opened. Anything new for Compute outside its own pages goes behind
`useConnectedComputeProviders()`, and anything of size behind a lazy import, so the perf gate's default mock, which
connects nothing, stays flat. `bun run perf` measures the Compute page with `?compute=typical`.

## Adding a provider

One Rust module in `compute/` implementing `ComputeProvider`, listed in `PROVIDERS`, with a `ComputeProviderId`
variant; one record in `COMPUTE_PROVIDERS` (`services/computeHint.ts`) for its name, key placeholder and read-only
key command; and its own mark, drawn in `components/compute/ComputeProviderMark.tsx` and listed in its `MARKS`. The
mark is an inline SVG with a fill for each theme, not an image: two `<img>`s would cost a DOM mutation apiece wherever
it's drawn, and it stays out of `computeHint.ts` so launch doesn't load it. Shared copy takes the provider's name as a
parameter, so no string changes. A provider that
can't report something says so in its `capabilities`, and the screens leave that part out.
