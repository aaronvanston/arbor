//! Machine health sampling for the fleet.
//!
//! One background loop samples every configured host (local shell or SSH),
//! derives a 0–100 health score from CPU, memory, swap, disk, load and
//! temperature pressure, and keeps a bounded in-memory ring of points per
//! machine. Nothing is persisted: the ring is capped at one hour and the
//! process never holds more than `MAX_POINTS` samples per machine, so memory
//! stays flat no matter how long the app runs.
//!
//! Cadence is adaptive: while the Machines page is being viewed the loop
//! samples every `ACTIVE_INTERVAL`; otherwise it drops to `IDLE_INTERVAL` so
//! the hour of history stays continuous without hammering the fleet.
//!
//! Each round also pings the remote machines at the address SSH resolves them
//! to, and asks Tailscale (about once a minute) how it reaches the ones on a
//! tailnet: on the local network, directly over the internet, or through a
//! relay. Latency is tracked alongside the other readings but never counts
//! toward the score.
//!
//! Each sample also counts the Claude Code and Codex processes running on the
//! machine; which versions are installed is checked less often, in `agents`.
//! Where each session ran, and what it was called, is read from the machine's
//! transcripts every few minutes, in `transcripts`. Which sessions are waiting
//! on their user is asked every few seconds, in `attention`, of the machines
//! where Arbor's reporter is set up. What each machine's agents load (their
//! instructions, skills, MCP servers and settings) is read when the Setup page
//! asks, in `setup`. Machines this Mac already reaches, offered when one is
//! added, are found in `discovery`. T3 Code's threads, for the fleet board, are
//! read from its database on each machine that has one, in `t3_threads`.

pub(crate) mod agent_homes;
pub(crate) mod agent_install;
pub(crate) mod agent_releases;
pub(crate) mod agents;
pub(crate) mod archive;
pub(crate) mod automations;
pub(crate) mod attention;
pub(crate) mod checkout_settings;
pub(crate) mod cli_skill;
pub(crate) mod client_versions;
pub(crate) mod discovery;
pub(crate) mod fix_session;
pub(crate) mod guarded_writes;
pub(crate) mod harness_update;
pub(crate) mod harnesses;
pub(crate) mod keep_sessions;
pub(crate) mod pool_ssh;
pub(crate) mod pools;
pub(crate) mod runs;
pub(crate) mod project_instructions;
pub(crate) mod setup;
pub(crate) mod setup_hooks;
pub(crate) mod setup_mcp;
pub(crate) mod setup_plugins;
pub(crate) mod setup_projects;
pub(crate) mod setup_repo_browse;
pub(crate) mod setup_repo_skills;
pub(crate) mod setup_skills;
pub(crate) mod setup_sync;
pub(crate) mod setup_wanted;
pub(crate) mod setup_toolchain;
pub(crate) mod shell;
pub(crate) mod starting_context;
pub(crate) mod t3_threads;
pub(crate) mod telemetry;
pub(crate) mod transcripts;

use super::diagnostics::{self, MachineOp};
use ts_rs::TS;
use super::*;
#[cfg(test)]
use self::shell::{run_script, shells};
use self::shell::{
    configure_helper_command, failure_detail, find_machine, not_checked, run_checked, run_on_machine, runs_scripts, this_machine_name,
    Machine, MachineCommand,
};
use std::collections::{BTreeMap, VecDeque};
use std::net::IpAddr;
use std::process::Stdio;
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

const MAX_POINTS: usize = 720;
const HISTORY_MS: i64 = 60 * 60 * 1000;
const ACTIVE_INTERVAL: Duration = Duration::from_secs(5);
const IDLE_INTERVAL: Duration = Duration::from_secs(60);
const ACTIVE_GRACE: Duration = Duration::from_secs(20);
const SAMPLE_TIMEOUT: Duration = Duration::from_secs(12);
const HOSTS_REFRESH: Duration = Duration::from_secs(60);
/// `ssh -G` runs again for a host only when it's new or changed, or an hour on, to catch a change to ~/.ssh/config.
const PING_TARGET_REFRESH: Duration = Duration::from_secs(60 * 60);
const PING_TIMEOUT: Duration = Duration::from_secs(4);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
/// A Tailscale status read is reused this long. A failed one is tried again after each of
/// `TAILSCALE_RETRIES` in turn, then only this often.
const TAILSCALE_READ_TTL: Duration = Duration::from_secs(60);
const TAILSCALE_RETRIES: [Duration; 2] = [Duration::from_secs(10), Duration::from_secs(30)];

pub(crate) const MACHINE_HEALTH_UPDATED_EVENT: &str = "machine-health-updated";

// One portable POSIX sh script reads everything in a single round trip and
// emits key=value lines. Mandatory readings come first; every optional probe
// is guarded so a missing sensor emits no line rather than a bogus zero.
// The script is fed to `sh` on stdin so it never depends on the login shell.
const SAMPLE_SCRIPT: &str = r##"set -u
export LC_ALL=C
opt() { if [ -n "${2:-}" ]; then printf '%s=%s\n' "$1" "$2"; fi; }
os=$(uname -s); arch=$(uname -m); host=$(uname -n)
cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)
cpu_pct=""; cpu_total=""; cpu_idle=""; swap=""; uptime_s=""; batt=""
cpu_temp=""; gpu_temp=""; gpu_util=""; gpu_name=""; gpu_mem_used=""; gpu_mem_total=""
ip=""; model=""; product=""; chip=""; os_version=""
if [ "$os" = "Darwin" ]; then
  loadavg=$(sysctl -n vm.loadavg)
  l1=$(printf '%s' "$loadavg" | awk '{ print $2 }')
  l5=$(printf '%s' "$loadavg" | awk '{ print $3 }')
  l15=$(printf '%s' "$loadavg" | awk '{ print $4 }')
  mem_total=$(( $(sysctl -n hw.memsize) / 1024 ))
  page=$(sysctl -n hw.pagesize)
  mem_avail=$(vm_stat | awk -v p="$page" -F'[: .]+' '/^Pages free/ { f = $3 } /^Pages inactive/ { i = $3 } /^Pages speculative/ { s = $3 } END { printf "%d", (f + i + s) * p / 1024 }')
  cpu_pct=$(ps -A -o %cpu= | awk -v c="$cores" '{ s += $1 } END { if (c < 1) c = 1; v = s / c; if (v > 100) v = 100; printf "%.1f", v }')
  net=$(netstat -ibn | awk '$3 ~ /Link/ && $1 != "lo0" { rx += $(NF-4); tx += $(NF-1) } END { printf "%d %d", rx, tx }')
  boot=$(sysctl -n kern.boottime 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "sec") { gsub(/[^0-9]/, "", $(i + 2)); print $(i + 2); exit } }' || true)
  if [ -n "$boot" ]; then uptime_s=$(awk -v b="$boot" -v n="$(date +%s)" 'BEGIN { printf "%d", n - b }'); fi
  swap=$(sysctl -n vm.swapusage 2>/dev/null | awk '{ t = $3; u = $6; sub(/[A-Za-z]$/, "", t); sub(/[A-Za-z]$/, "", u); printf "%d %d", t * 1024, u * 1024 }' || true)
  batt=$(pmset -g batt 2>/dev/null | awk -F'[;\t]' '/InternalBattery/ { gsub(/%/, "", $2); gsub(/^[ \t]+|[ \t]+$/, "", $3); printf "%s %s", $2, $3; exit }' || true)
  # The model identifier ("Mac16,8") and, on Apple silicon, the name Apple sells it under
  # ("MacBook Pro (14-inch, 2024)"). Only those two lines are kept: the serial number and
  # UUID ioreg prints beside them never leave the machine.
  model=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '$2 == "model" { print $4; exit }' || true)
  if [ -z "$model" ]; then model=$(sysctl -n hw.model 2>/dev/null || true); fi
  product=$(ioreg -rd1 -n product 2>/dev/null | awk -F'"' '$2 == "product-name" { print $4; exit }' || true)
  chip=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)
  os_version=$(sw_vers -productVersion 2>/dev/null || true)
  if [ "$arch" = "arm64" ]; then gpu_name="$chip"; fi
  mm=""
  for c in macmon /opt/homebrew/bin/macmon /usr/local/bin/macmon; do
    if command -v "$c" >/dev/null 2>&1; then mm=$("$c" pipe -s 1 -i 200 2>/dev/null | head -n 1 || true); break; fi
  done
  if [ -n "$mm" ]; then
    cpu_temp=$(printf '%s' "$mm" | sed -n 's/.*"cpu_temp_avg":\([0-9][0-9]*\(\.[0-9]*\)\{0,1\}\).*/\1/p' | awk '{ printf "%.1f", $1 }')
    gpu_temp=$(printf '%s' "$mm" | sed -n 's/.*"gpu_temp_avg":\([0-9][0-9]*\(\.[0-9]*\)\{0,1\}\).*/\1/p' | awk '{ printf "%.1f", $1 }')
    gpu_util=$(printf '%s' "$mm" | sed -n 's/.*"gpu_active_ratio":\([0-9][0-9]*\(\.[0-9]*\)\{0,1\}\).*/\1/p' | awk '{ v = $1 * 100; if (v > 100) v = 100; printf "%.1f", v }')
  fi
  iface=$(route -n get default 2>/dev/null | awk '/interface:/ { print $2; exit }' || true)
  if [ -z "$iface" ]; then iface=en0; fi
  ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
  disk_path=/
  if [ -d /System/Volumes/Data ]; then disk_path=/System/Volumes/Data; fi
else
  loadavg=$(cat /proc/loadavg)
  l1=$(printf '%s' "$loadavg" | awk '{ print $1 }')
  l5=$(printf '%s' "$loadavg" | awk '{ print $2 }')
  l15=$(printf '%s' "$loadavg" | awk '{ print $3 }')
  mem_total=$(awk '/^MemTotal/ { print $2 }' /proc/meminfo)
  mem_avail=$(awk '/^MemAvailable/ { print $2 }' /proc/meminfo)
  cpu_line=$(head -n 1 /proc/stat)
  cpu_total=$(printf '%s' "$cpu_line" | awk '{ print $2 + $3 + $4 + $5 + $6 + $7 + $8 + $9 }')
  cpu_idle=$(printf '%s' "$cpu_line" | awk '{ print $5 + $6 }')
  cpu_pct=$(ps -A -o %cpu= 2>/dev/null | awk -v c="$cores" '{ s += $1 } END { if (c < 1) c = 1; v = s / c; if (v > 100) v = 100; printf "%.1f", v }' || true)
  net=$(awk 'NR > 2 { gsub(/:/, " "); if ($1 != "lo") { rx += $2; tx += $10 } } END { printf "%d %d", rx, tx }' /proc/net/dev)
  uptime_s=$(awk '{ printf "%d", $1 }' /proc/uptime 2>/dev/null || true)
  swap=$(awk '/^SwapTotal/ { t = $2 } /^SwapFree/ { f = $2 } END { if (t == "") exit 1; printf "%d %d", t, t - f }' /proc/meminfo || true)
  for b in /sys/class/power_supply/BAT*; do
    if [ -r "$b/capacity" ]; then
      cap=$(cat "$b/capacity" 2>/dev/null || true)
      state=$(cat "$b/status" 2>/dev/null || echo unknown)
      if [ -n "$cap" ]; then batt="$cap $state"; break; fi
    fi
  done
  for h in /sys/class/hwmon/hwmon*; do
    [ -r "$h/name" ] || continue
    case "$(cat "$h/name" 2>/dev/null || true)" in
      coretemp|k10temp|zenpower|cpu_thermal|soc_thermal)
        v=$(cat "$h/temp1_input" 2>/dev/null || true)
        if [ -n "$v" ]; then cpu_temp=$(awk -v v="$v" 'BEGIN { printf "%.1f", v / 1000 }'); break; fi
        ;;
    esac
  done
  if [ -z "$cpu_temp" ]; then
    for z in /sys/class/thermal/thermal_zone*; do
      [ -r "$z/type" ] || continue
      case "$(cat "$z/type" 2>/dev/null || true)" in
        x86_pkg_temp|cpu-thermal|cpu_thermal)
          v=$(cat "$z/temp" 2>/dev/null || true)
          if [ -n "$v" ]; then cpu_temp=$(awk -v v="$v" 'BEGIN { printf "%.1f", v / 1000 }'); break; fi
          ;;
      esac
    done
  fi
  model=$(cat /sys/class/dmi/id/product_name 2>/dev/null || cat /sys/firmware/devicetree/base/model 2>/dev/null || true)
  model=$(printf '%s' "$model" | tr -d '\000' | awk 'NR == 1 { print }')
  chip=$(awk -F': ' '/^model name/ { print $2; exit } /^Model/ { print $2; exit }' /proc/cpuinfo 2>/dev/null || true)
  os_version=$(awk -F= '/^PRETTY_NAME=/ { gsub(/"/, "", $2); print $2; exit }' /etc/os-release 2>/dev/null || true)
  if [ -z "$os_version" ]; then os_version=$(uname -r); fi
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true)
  if [ -z "$ip" ]; then ip=$(hostname -I 2>/dev/null | awk '{ print $1 }' || true); fi
  disk_path=/
  if command -v nvidia-smi >/dev/null 2>&1; then
    nv=$(nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1 || true)
    if [ -n "$nv" ]; then
      gpu_name=$(printf '%s' "$nv" | awk -F', ' '{ print $1 }')
      gpu_util=$(printf '%s' "$nv" | awk -F', ' '$2 ~ /^[0-9]/ { print $2 }')
      gpu_temp=$(printf '%s' "$nv" | awk -F', ' '$3 ~ /^[0-9]/ { print $3 }')
      gpu_mem_used=$(printf '%s' "$nv" | awk -F', ' '$4 ~ /^[0-9]/ { print $4 }')
      gpu_mem_total=$(printf '%s' "$nv" | awk -F', ' '$5 ~ /^[0-9]/ { print $5 }')
    fi
  fi
  if [ -z "$gpu_name" ]; then
    for c in /sys/class/drm/card[0-9]; do
      [ -r "$c/device/vendor" ] || continue
      vendor=$(cat "$c/device/vendor" 2>/dev/null || true)
      case "$vendor" in
        0x1002|0x10de) ;;
        *) continue ;;
      esac
      busy=$(cat "$c/device/gpu_busy_percent" 2>/dev/null || true)
      if [ -n "$busy" ]; then gpu_util="$busy"; fi
      for h in "$c"/device/hwmon/hwmon*; do
        v=$(cat "$h/temp1_input" 2>/dev/null || true)
        if [ -n "$v" ]; then gpu_temp=$(awk -v v="$v" 'BEGIN { printf "%.1f", v / 1000 }'); break; fi
      done
      case "$vendor" in 0x1002) brand="AMD"; match="AMD|ATI" ;; *) brand="NVIDIA"; match="NVIDIA" ;; esac
      if command -v lspci >/dev/null 2>&1; then
        gpu_name=$(lspci -mm 2>/dev/null | awk -F'" "' -v m="$match" -v b="$brand" 'tolower($1) ~ /vga|3d|display/ && $2 ~ m { n = $3; sub(/".*/, "", n); if (match(n, /\[[^]]+\]/)) n = substr(n, RSTART + 1, RLENGTH - 2); print b " " n; exit }' || true)
      fi
      if [ -z "$gpu_name" ]; then gpu_name="$brand GPU"; fi
      break
    done
  fi
fi
rx=$(printf '%s' "$net" | awk '{ print $1 }')
tx=$(printf '%s' "$net" | awk '{ print $2 }')
swap_total=$(printf '%s' "$swap" | awk '{ print $1 }')
swap_used=$(printf '%s' "$swap" | awk '{ print $2 }')
batt_pct=$(printf '%s' "$batt" | awk '{ print $1 }')
batt_state=$(printf '%s' "$batt" | awk '{ $1 = ""; sub(/^ +/, ""); print }')
disk=$(df -kP "$disk_path" | awk 'NR == 2 { printf "%d %d", $2, $2 - $4 }')
dtotal=$(printf '%s' "$disk" | awk '{ print $1 }')
dused=$(printf '%s' "$disk" | awk '{ print $2 }')
# Claude Code and Codex processes, by the name they were started with (a
# native binary, a version-named Claude build, or Node running the package).
# Only the counts leave the machine, never the command lines.
agents=$(ps -A -ww -o args= 2>/dev/null | awk '
  / --chrome-native-host/ { next }
  { n = split($1, p, "/"); b = p[n]; m = split($2, q, "/"); s = m ? q[m] : "" }
  b == "claude" || $1 ~ /\/claude\/versions\/[^\/]+$/ || ((b == "node" || b == "bun") && (s == "claude" || $2 ~ /@anthropic-ai\/claude-code\/cli\.js$/)) { c++; next }
  b == "codex" { x++ }
  END { printf "%d %d", c, x }' || true)
claude_running=$(printf '%s' "$agents" | awk '{ print $1 }')
codex_running=$(printf '%s' "$agents" | awk '{ print $2 }')
printf 'hostname=%s\nos=%s\narch=%s\ncores=%s\nload1=%s\nload5=%s\nload15=%s\nmem_total_kb=%s\nmem_available_kb=%s\ndisk_total_kb=%s\ndisk_used_kb=%s\nnet_rx_bytes=%s\nnet_tx_bytes=%s\n' \
  "$host" "$os" "$arch" "$cores" "$l1" "$l5" "$l15" "$mem_total" "$mem_avail" "$dtotal" "$dused" "$rx" "$tx"
opt cpu_pct "$cpu_pct"
opt cpu_total_jiffies "$cpu_total"
opt cpu_idle_jiffies "$cpu_idle"
opt ip "$ip"
opt model "$model"
opt product_name "$product"
opt chip "$chip"
opt gpu_name "$gpu_name"
opt gpu_util "$gpu_util"
opt gpu_temp_c "$gpu_temp"
opt gpu_mem_used_mb "$gpu_mem_used"
opt gpu_mem_total_mb "$gpu_mem_total"
opt os_version "$os_version"
opt uptime_s "$uptime_s"
opt swap_total_kb "$swap_total"
opt swap_used_kb "$swap_used"
opt cpu_temp_c "$cpu_temp"
opt battery_pct "$batt_pct"
opt battery_state "$batt_state"
opt claude_running "$claude_running"
opt codex_running "$codex_running"
"##;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineHost {
    pub machine: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub source: String,
}

fn default_port() -> u16 {
    22
}

fn default_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineFacts {
    hostname: String,
    os: String,
    os_version: String,
    arch: String,
    /// The model identifier on a Mac ("Mac16,8"); the board or product name elsewhere.
    model: String,
    /// What a Mac on Apple silicon calls itself ("MacBook Pro (14-inch, 2024)"); empty elsewhere.
    product_name: String,
    chip: String,
    gpu: String,
    cores: u32,
    mem_total_kb: u64,
    disk_total_kb: u64,
    swap_total_kb: Option<u64>,
    gpu_mem_total_mb: Option<u64>,
    ip: String,
    uptime_s: Option<u64>,
    battery_pct: Option<f32>,
    battery_state: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealthPoint {
    t: i64,
    score: u8,
    cpu: Option<f32>,
    mem: f32,
    mem_used_kb: u64,
    swap: Option<f32>,
    swap_used_kb: Option<u64>,
    disk: f32,
    disk_free_kb: u64,
    load1: f32,
    load5: f32,
    load15: f32,
    rx_bps: Option<f64>,
    tx_bps: Option<f64>,
    latency_ms: Option<f32>,
    cpu_temp: Option<f32>,
    gpu_temp: Option<f32>,
    gpu_util: Option<f32>,
    gpu_mem_used_mb: Option<u64>,
    /// Claude Code and Codex processes running when the sample was taken.
    claude_running: Option<u32>,
    codex_running: Option<u32>,
}

/// What a health score is read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HealthMetric {
    Cpu,
    Memory,
    Swap,
    Disk,
    Load,
    CpuTemp,
    GpuTemp,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealthReason {
    metric: HealthMetric,
    value: f32,
}

/// How Tailscale reaches a machine: "lan" (directly on the local network),
/// "direct" (directly over the internet) or "relay" (through a relay, with its
/// DERP region when there is one).
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkPath {
    kind: &'static str,
    relay: Option<String>,
}

/// Everything the score needs, independent of how it was sampled.
#[derive(Clone, Copy, Debug, Default)]
struct HealthInputs {
    cpu: Option<f32>,
    mem: f32,
    swap: Option<f32>,
    disk: f32,
    load_per_core: f32,
    cpu_temp: Option<f32>,
    gpu_temp: Option<f32>,
}

fn ramp(value: f32, warn: f32, critical: f32) -> f32 {
    ((value - warn) / (critical - warn)).clamp(0.0, 1.0)
}

/// Health is 100 minus weighted pressure. Each metric contributes nothing
/// until it crosses its warning threshold and its full weight at the critical
/// threshold, so an idle box scores 100 and a single saturated resource
/// drags the score into the degraded band on its own. The reason is the
/// metric contributing the most, when that contribution is visible.
fn assess(inputs: HealthInputs) -> (u8, Option<HealthReason>) {
    // Metric, weight, pressure, and the reading shown when it's the reason.
    let contributions: [(HealthMetric, f32, f32, f32); 7] = [
        (HealthMetric::Cpu, 35.0, inputs.cpu.map_or(0.0, |v| ramp(v, 75.0, 98.0)), inputs.cpu.unwrap_or(0.0)),
        (HealthMetric::Memory, 35.0, ramp(inputs.mem, 78.0, 96.0), inputs.mem),
        (HealthMetric::Swap, 15.0, inputs.swap.map_or(0.0, |v| ramp(v, 50.0, 90.0)), inputs.swap.unwrap_or(0.0)),
        (HealthMetric::Disk, 30.0, ramp(inputs.disk, 82.0, 96.0), inputs.disk),
        (HealthMetric::Load, 15.0, ramp(inputs.load_per_core, 1.0, 2.5), inputs.load_per_core),
        (HealthMetric::CpuTemp, 20.0, inputs.cpu_temp.map_or(0.0, |v| ramp(v, 82.0, 97.0)), inputs.cpu_temp.unwrap_or(0.0)),
        (HealthMetric::GpuTemp, 15.0, inputs.gpu_temp.map_or(0.0, |v| ramp(v, 82.0, 95.0)), inputs.gpu_temp.unwrap_or(0.0)),
    ];
    let mut penalty = 0.0_f32;
    let mut worst: Option<(HealthReason, f32)> = None;
    for (metric, weight, pressure, value) in contributions {
        let contribution = weight * pressure;
        penalty += contribution;
        if contribution > 2.0 && worst.is_none_or(|(_, best)| contribution > best) {
            worst = Some((HealthReason { metric, value }, contribution));
        }
    }
    let score = (100.0 - penalty).clamp(0.0, 100.0).round() as u8;
    (score, worst.map(|(reason, _)| reason))
}

/// How a machine is doing: a band of its score, or why there's no score.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HealthStatus {
    Healthy,
    Degraded,
    Critical,
    Unreachable,
    /// Not sampled yet.
    Pending,
    /// No host to reach it at.
    Unconfigured,
}

pub(crate) fn status_for_score(score: u8) -> HealthStatus {
    if score >= 75 {
        HealthStatus::Healthy
    } else if score >= 45 {
        HealthStatus::Degraded
    } else {
        HealthStatus::Critical
    }
}

#[derive(Clone, Copy, Debug)]
struct Counters {
    at_ms: i64,
    rx: u64,
    tx: u64,
    cpu_total: Option<u64>,
    cpu_idle: Option<u64>,
}

/// Parsed key=value output of the sample script.
#[derive(Clone, Debug, Default)]
struct RawSample {
    fields: HashMap<String, String>,
}

impl RawSample {
    fn parse(stdout: &str) -> Result<Self, String> {
        let mut fields = HashMap::new();
        for line in stdout.lines() {
            if let Some((key, value)) = line.split_once('=') {
                let value = value.trim();
                if !value.is_empty() {
                    fields.insert(key.trim().to_string(), value.to_string());
                }
            }
        }
        let sample = Self { fields };
        for key in [
            "hostname",
            "os",
            "arch",
            "cores",
            "load1",
            "mem_total_kb",
            "mem_available_kb",
            "disk_total_kb",
            "disk_used_kb",
            "net_rx_bytes",
            "net_tx_bytes",
        ] {
            if !sample.fields.contains_key(key) {
                return Err(format!("The machine returned an unreadable sample (missing {key})"));
            }
        }
        Ok(sample)
    }

    fn text(&self, key: &str) -> String {
        self.fields.get(key).cloned().unwrap_or_default()
    }

    fn number<T: std::str::FromStr>(&self, key: &str) -> Option<T> {
        self.fields.get(key).and_then(|value| value.parse().ok())
    }

    fn required<T: std::str::FromStr>(&self, key: &str) -> Result<T, String> {
        self.number(key)
            .ok_or_else(|| format!("The machine returned an unreadable {key} value"))
    }
}

fn percent(used: f64, total: f64) -> f32 {
    if total <= 0.0 {
        0.0
    } else {
        ((used / total) * 1000.0).round() as f32 / 10.0
    }
}

fn rate(newer: u64, older: u64, elapsed_ms: i64) -> Option<f64> {
    if elapsed_ms <= 0 || newer < older {
        return None;
    }
    Some((newer - older) as f64 * 1000.0 / elapsed_ms as f64)
}

/// Turn a raw sample into facts plus a point. Rates come from the previous
/// counters, so the very first point of a machine has no network rate and,
/// on Linux, falls back to the process-table CPU estimate until a second
/// `/proc/stat` reading exists.
fn derive_point(
    sample: &RawSample,
    previous: Option<Counters>,
    at_ms: i64,
) -> Result<(MachineFacts, HealthPoint, Counters, Option<HealthReason>), String> {
    let cores: u32 = sample.required("cores")?;
    let cores = cores.max(1);
    let mem_total_kb: u64 = sample.required("mem_total_kb")?;
    let mem_available_kb: u64 = sample.required("mem_available_kb")?;
    let disk_total_kb: u64 = sample.required("disk_total_kb")?;
    let disk_used_kb: u64 = sample.required("disk_used_kb")?;
    let rx: u64 = sample.required("net_rx_bytes")?;
    let tx: u64 = sample.required("net_tx_bytes")?;
    let load1: f32 = sample.required("load1")?;
    let load5: f32 = sample.number("load5").unwrap_or(load1);
    let load15: f32 = sample.number("load15").unwrap_or(load1);
    let cpu_total: Option<u64> = sample.number("cpu_total_jiffies");
    let cpu_idle: Option<u64> = sample.number("cpu_idle_jiffies");
    let counters = Counters {
        at_ms,
        rx,
        tx,
        cpu_total,
        cpu_idle,
    };
    let cpu_from_counters = match (previous, cpu_total, cpu_idle) {
        (Some(prev), Some(total), Some(idle)) => match (prev.cpu_total, prev.cpu_idle) {
            (Some(prev_total), Some(prev_idle)) if total > prev_total && idle >= prev_idle => {
                let busy = (total - prev_total).saturating_sub(idle - prev_idle) as f64;
                Some(percent(busy, (total - prev_total) as f64).clamp(0.0, 100.0))
            }
            _ => None,
        },
        _ => None,
    };
    let cpu = cpu_from_counters.or_else(|| sample.number::<f32>("cpu_pct").map(|v| v.clamp(0.0, 100.0)));
    let mem_used_kb = mem_total_kb.saturating_sub(mem_available_kb);
    let mem = percent(mem_used_kb as f64, mem_total_kb as f64);
    let swap_total_kb: Option<u64> = sample.number("swap_total_kb").filter(|v| *v > 0);
    let swap_used_kb: Option<u64> = swap_total_kb.and_then(|_| sample.number("swap_used_kb"));
    let swap = match (swap_total_kb, swap_used_kb) {
        (Some(total), Some(used)) => Some(percent(used as f64, total as f64)),
        _ => None,
    };
    let disk = percent(disk_used_kb as f64, disk_total_kb as f64);
    let cpu_temp: Option<f32> = sample.number("cpu_temp_c");
    let gpu_temp: Option<f32> = sample.number("gpu_temp_c");
    let gpu_util: Option<f32> = sample.number("gpu_util");
    let (score, reason) = assess(HealthInputs {
        cpu,
        mem,
        swap,
        disk,
        load_per_core: load1 / cores as f32,
        cpu_temp,
        gpu_temp,
    });
    let elapsed_ms = previous.map_or(0, |prev| at_ms - prev.at_ms);
    let point = HealthPoint {
        t: at_ms,
        score,
        cpu,
        mem,
        mem_used_kb,
        swap,
        swap_used_kb,
        disk,
        disk_free_kb: disk_total_kb.saturating_sub(disk_used_kb),
        load1,
        load5,
        load15,
        rx_bps: previous.and_then(|prev| rate(rx, prev.rx, elapsed_ms)),
        tx_bps: previous.and_then(|prev| rate(tx, prev.tx, elapsed_ms)),
        latency_ms: None,
        cpu_temp,
        gpu_temp,
        gpu_util,
        gpu_mem_used_mb: sample.number("gpu_mem_used_mb"),
        claude_running: sample.number("claude_running"),
        codex_running: sample.number("codex_running"),
    };
    let facts = MachineFacts {
        hostname: sample.text("hostname"),
        os: sample.text("os"),
        os_version: sample.text("os_version"),
        arch: sample.text("arch"),
        model: sample.text("model"),
        product_name: sample.text("product_name"),
        chip: sample.text("chip"),
        gpu: sample.text("gpu_name"),
        cores,
        mem_total_kb,
        disk_total_kb,
        swap_total_kb,
        gpu_mem_total_mb: sample.number("gpu_mem_total_mb"),
        ip: sample.text("ip"),
        uptime_s: sample.number("uptime_s"),
        battery_pct: sample.number("battery_pct"),
        battery_state: sample.text("battery_state"),
    };
    Ok((facts, point, counters, reason))
}

struct MachineSeries {
    host: MachineHost,
    local: bool,
    facts: Option<MachineFacts>,
    points: VecDeque<HealthPoint>,
    counters: Option<Counters>,
    reason: Option<HealthReason>,
    error: Option<String>,
    last_ok_at: Option<i64>,
    last_attempt_at: Option<i64>,
    /// Where pings go: the host name SSH resolves the endpoint to. None for
    /// this machine, and when SSH goes through a jump host or proxy command.
    ping_target: Option<String>,
    path: Option<NetworkPath>,
    agents: agents::MachineAgents,
    transcripts: transcripts::TranscriptScans,
    attention: attention::AttentionLog,
    t3: t3_threads::T3Log,
    setup: setup::MachineSetup,
}

impl MachineSeries {
    fn new(host: MachineHost, local: bool) -> Self {
        Self {
            host,
            local,
            facts: None,
            points: VecDeque::new(),
            counters: None,
            reason: None,
            error: None,
            last_ok_at: None,
            last_attempt_at: None,
            ping_target: None,
            path: None,
            agents: agents::MachineAgents::default(),
            transcripts: transcripts::TranscriptScans::default(),
            attention: attention::AttentionLog::default(),
            t3: t3_threads::T3Log::default(),
            setup: setup::MachineSetup::default(),
        }
    }

    fn push(&mut self, point: HealthPoint) {
        self.points.push_back(point);
        self.trim(point.t);
    }

    fn trim(&mut self, now_ms: i64) {
        while self
            .points
            .front()
            .is_some_and(|front| self.points.len() > MAX_POINTS || front.t < now_ms - HISTORY_MS)
        {
            self.points.pop_front();
        }
    }
}

struct Inner {
    series: BTreeMap<String, MachineSeries>,
    seq: u64,
    last_viewed: Option<Instant>,
    token: Option<CancellationToken>,
    reload_hosts: bool,
    last_round_at: Option<i64>,
    interval_ms: u64,
    local_names: Vec<String>,
    /// Transcript scans of this machine when the Machines page doesn't list it.
    local_transcripts: transcripts::TranscriptScans,
    /// What this machine's agents load, when the Machines page doesn't list it.
    local_setup: setup::MachineSetup,
    /// This machine's T3 Code threads, when the Machines page doesn't list it.
    local_t3: t3_threads::T3Log,
    /// Each machine's git checkouts, from the last scan of its projects.
    projects: BTreeMap<String, setup_projects::MachineProjects>,
    /// Each machine's tools and what its projects ask of them, from the last scan.
    toolchain: BTreeMap<String, setup_toolchain::MachineToolchain>,
    /// Sessions working now on each machine (normalized name), as the window's live board last
    /// counted them; None until it has. Pools count agents by it, so they match the sidebar and Home.
    working_sessions: Option<BTreeMap<String, u32>>,
}

pub(crate) struct MachineHealthState {
    inner: Mutex<Inner>,
    notify: Notify,
    /// Held while a read runs, so the sampler and the Add machine dialog never read at once.
    tailscale: tokio::sync::Mutex<TailscaleCache<fn() -> Instant, TailscaleStatus>>,
}

impl Default for MachineHealthState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                series: BTreeMap::new(),
                seq: 0,
                last_viewed: None,
                token: None,
                reload_hosts: true,
                last_round_at: None,
                interval_ms: ACTIVE_INTERVAL.as_millis() as u64,
                local_names: Vec::new(),
                local_transcripts: transcripts::TranscriptScans::default(),
                local_setup: setup::MachineSetup::default(),
                local_t3: t3_threads::T3Log::default(),
                projects: BTreeMap::new(),
                toolchain: BTreeMap::new(),
                working_sessions: None,
            }),
            notify: Notify::new(),
            tailscale: tokio::sync::Mutex::new(TailscaleCache::new(Instant::now as fn() -> Instant)),
        }
    }
}

impl MachineHealthState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn start(&self) -> Option<CancellationToken> {
        let mut inner = self.lock();
        if inner.token.is_some() {
            return None;
        }
        let token = CancellationToken::new();
        inner.token = Some(token.clone());
        Some(token)
    }

    fn stop(&self) {
        if let Some(token) = self.lock().token.take() {
            token.cancel();
        }
        self.notify.notify_one();
    }

    fn is_active(&self) -> bool {
        self.lock()
            .last_viewed
            .is_some_and(|viewed| viewed.elapsed() < ACTIVE_GRACE)
    }

    /// Called by the page poll: record interest and wake the loop when it is
    /// idling so the first paint after opening the page is not a minute away.
    fn touch(&self) {
        let mut inner = self.lock();
        inner.last_viewed = Some(Instant::now());
        if inner.interval_ms > ACTIVE_INTERVAL.as_millis() as u64 {
            inner.interval_ms = ACTIVE_INTERVAL.as_millis() as u64;
            self.notify.notify_one();
        }
    }

    fn request_reload(&self) {
        self.lock().reload_hosts = true;
        self.notify.notify_one();
    }

    /// Tailscale's status from a read no more than a minute old; None when it can't be read.
    async fn tailscale_status(&self) -> Option<TailscaleStatus> {
        self.tailscale.lock().await.get(read_tailscale_status).await
    }
}

fn is_local_endpoint(endpoint: &str, local_names: &[String]) -> bool {
    let candidate = endpoint.trim().to_ascii_lowercase();
    if matches!(candidate.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return true;
    }
    let short = candidate.trim_end_matches(".local");
    local_names
        .iter()
        .any(|name| name == &candidate || name == short)
}

fn detect_local_names() -> Vec<String> {
    let mut names = Vec::new();
    #[cfg(unix)]
    if let Ok(output) = std::process::Command::new("uname").arg("-n").output() {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_ascii_lowercase();
        if !name.is_empty() {
            names.push(name.trim_end_matches(".local").to_string());
            names.push(name);
        }
    }
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        names.push(name.to_ascii_lowercase());
    }
    if let Ok(name) = std::env::var("HOSTNAME") {
        names.push(name.to_ascii_lowercase());
    }
    names
}

async fn sample_host(machine: &Machine) -> Result<RawSample, String> {
    RawSample::parse(&run_checked(machine, MachineOp::HealthCheck, SAMPLE_SCRIPT, SAMPLE_TIMEOUT).await?)
}

/// Where a remote host's pings go, read from `ssh -G` so aliases, `user@`
/// endpoints and HostName overrides reach the same machine the samples do.
async fn resolve_ping_target(host: &MachineHost) -> Option<String> {
    let mut command = tokio::process::Command::new("ssh");
    command
        .arg("-G")
        .arg("-p")
        .arg(host.port.to_string())
        .arg("--")
        .arg(host.endpoint.trim())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    configure_helper_command(&mut command);
    let output = tokio::time::timeout(COMMAND_TIMEOUT, command.output()).await.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    ping_target_from_ssh_config(&String::from_utf8_lossy(&output.stdout))
}

/// The resolved host name from `ssh -G` output. None when a jump host or proxy
/// command sits in between, where a direct ping would measure another path.
fn ping_target_from_ssh_config(config: &str) -> Option<String> {
    let mut hostname = None;
    for line in config.lines() {
        let Some((key, value)) = line.trim().split_once(' ') else {
            continue;
        };
        let value = value.trim();
        match key {
            "hostname" => hostname = Some(value),
            "proxyjump" | "proxycommand" if value != "none" => return None,
            _ => {}
        }
    }
    hostname
        .filter(|name| !name.is_empty() && !name.starts_with('-'))
        .map(str::to_string)
}

/// Re-reads where each remote machine's pings go. Runs with every host
/// refresh, so SSH config edits are picked up within a minute.
/// Resolves the hosts `resolved` has no fresh answer for, and notes when each was.
async fn resolve_ping_targets(state: &MachineHealthState, resolved: &mut HashMap<String, (MachineHost, Instant)>) {
    let hosts: Vec<(String, MachineHost)> = state
        .lock()
        .series
        .values()
        .filter(|series| !series.local && series.host.enabled && !series.host.endpoint.trim().is_empty())
        .filter(|series| {
            resolved
                .get(&series.host.machine)
                .is_none_or(|(host, at)| *host != series.host || at.elapsed() >= PING_TARGET_REFRESH)
        })
        .map(|series| (series.host.machine.clone(), series.host.clone()))
        .collect();
    if hosts.is_empty() {
        return;
    }
    let answers = futures_util::future::join_all(hosts.into_iter().map(|(machine, host)| async move {
        let target = resolve_ping_target(&host).await;
        (machine, host, target)
    }))
    .await;
    let mut inner = state.lock();
    let now = Instant::now();
    for (machine, host, target) in answers {
        if let Some(series) = inner.series.get_mut(&machine).filter(|series| series.host == host) {
            series.ping_target = target;
        }
        resolved.insert(machine, (host, now));
    }
}

/// What a round of pings learned: the address the target resolved to, and the
/// median round trip of the replies.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct PingReading {
    address: Option<IpAddr>,
    latency_ms: Option<f32>,
}

fn ping_command(target: &str) -> tokio::process::Command {
    // Three pings, 0.2s apart, capped at a few seconds.
    let mut command = tokio::process::Command::new("/sbin/ping");
    command.args(["-c", "3", "-i", "0.2", "-t", "3"]);
    command
        .arg(target)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    configure_helper_command(&mut command);
    command
}

async fn ping_host(target: &str) -> PingReading {
    match tokio::time::timeout(PING_TIMEOUT, ping_command(target).output()).await {
        Ok(Ok(output)) => parse_ping(target, &String::from_utf8_lossy(&output.stdout)),
        _ => PingReading::default(),
    }
}

/// Reads ping's output on macOS, Linux or Windows. The median keeps one slow
/// reply from reading as a spike; no replies leave the latency unknown.
fn parse_ping(target: &str, output: &str) -> PingReading {
    let address = target.parse::<IpAddr>().ok().or_else(|| {
        let header = output
            .lines()
            .find(|line| line.starts_with("PING ") || line.starts_with("Pinging "))?;
        let end = header.find(|c| c == ')' || c == ']')?;
        let start = header[..end].rfind(|c| c == '(' || c == '[')? + 1;
        header[start..end].parse().ok()
    });
    let mut times: Vec<f32> = output
        .lines()
        .filter_map(|line| {
            let at = line.find("time=").or_else(|| line.find("time<"))? + "time=".len();
            let digits: String = line[at..]
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            digits.parse().ok()
        })
        .collect();
    times.sort_by(f32::total_cmp);
    let latency_ms = match times.len() {
        0 => None,
        count if count % 2 == 1 => Some(times[count / 2]),
        count => Some((times[count / 2 - 1] + times[count / 2]) / 2.0),
    };
    PingReading { address, latency_ms }
}

/// Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48.
fn is_tailnet(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [first, second, ..] = ip.octets();
            first == 100 && (64..128).contains(&second)
        }
        IpAddr::V6(ip) => ip.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

/// The Tailscale CLI: the Mac app's own binary, or a Homebrew, Linux or Windows install.
fn tailscale_cli() -> Option<PathBuf> {
    [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
        r"C:\Program Files\Tailscale\tailscale.exe",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
}

/// What one read of Tailscale's status says: how it reaches each peer right now,
/// keyed by every tailnet address the peer has, and which peers there are, for
/// the Add machine dialog to offer.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct TailscaleStatus {
    paths: HashMap<IpAddr, NetworkPath>,
    peers: Vec<discovery::TailscalePeer>,
}

/// None when the CLI is missing or Tailscale isn't running.
async fn read_tailscale_status() -> Option<TailscaleStatus> {
    let cli = tailscale_cli()?;
    let mut command = tokio::process::Command::new(cli);
    command
        .args(["status", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    configure_helper_command(&mut command);
    match tokio::time::timeout(COMMAND_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => serde_json::from_slice::<Value>(&output.stdout)
            .ok()
            .map(|status| TailscaleStatus { paths: paths_from_status(&status), peers: discovery::peers_from_status(&status) }),
        _ => None,
    }
}

/// The last Tailscale status read. On a Mac each run of the app's CLI can bring
/// back macOS's prompt to let it access data from other apps, and paths rarely
/// change between rounds, so a read is reused for `TAILSCALE_READ_TTL`. A failed
/// one is tried again soon, so Tailscale coming up shows quickly, but less often
/// each time it fails again: a read that keeps failing, as while that prompt is
/// up or was turned down, is then made once a minute like any other. The
/// sampler and the Add machine dialog share it, so offering peers doesn't add
/// reads of its own.
struct TailscaleCache<C, T> {
    clock: C,
    last: Option<(Instant, Option<T>)>,
    /// Reads that have failed in a row.
    failures: usize,
}

impl<C: Fn() -> Instant, T: Clone> TailscaleCache<C, T> {
    fn new(clock: C) -> Self {
        Self {
            clock,
            last: None,
            failures: 0,
        }
    }

    /// The last read while it's fresh, otherwise a new one from `read`. None when that read failed.
    async fn get<R>(&mut self, read: impl FnOnce() -> R) -> Option<T>
    where
        R: std::future::Future<Output = Option<T>>,
    {
        if let Some((at, value)) = &self.last {
            let keep = if value.is_some() {
                TAILSCALE_READ_TTL
            } else {
                TAILSCALE_RETRIES
                    .get(self.failures.saturating_sub(1))
                    .copied()
                    .unwrap_or(TAILSCALE_READ_TTL)
            };
            if (self.clock)().saturating_duration_since(*at) < keep {
                return value.clone();
            }
        }
        let value = read().await;
        self.failures = if value.is_some() { 0 } else { self.failures + 1 };
        self.last = Some(((self.clock)(), value.clone()));
        value
    }
}

fn paths_from_status(status: &Value) -> HashMap<IpAddr, NetworkPath> {
    let mut paths = HashMap::new();
    let peers = status.get("Peer").and_then(Value::as_object).into_iter().flat_map(|peers| peers.values());
    for peer in peers {
        let Some(path) = peer_path(peer) else {
            continue;
        };
        let addresses = peer.get("TailscaleIPs").and_then(Value::as_array).into_iter().flatten();
        for address in addresses.filter_map(Value::as_str).filter_map(|text| text.parse::<IpAddr>().ok()) {
            paths.insert(address, path.clone());
        }
    }
    paths
}

/// A peer's current path. `CurAddr` holds the endpoint while traffic flows
/// directly and is empty while it's relayed. `Relay` always names the peer's
/// home DERP region, so on its own it doesn't mean the traffic is relayed.
fn peer_path(peer: &Value) -> Option<NetworkPath> {
    if peer.get("Online").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let text = |key: &str| peer.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let current = text("CurAddr");
    if !current.is_empty() {
        let host = current.rsplit_once(':').map_or(current.as_str(), |(host, _)| host);
        let host = host.trim_start_matches('[').trim_end_matches(']');
        let host = host.split('%').next().unwrap_or(host);
        let lan = match host.parse::<IpAddr>() {
            Ok(IpAddr::V4(ip)) => ip.is_private() || ip.is_link_local(),
            Ok(IpAddr::V6(ip)) => ip.is_unique_local() || ip.is_unicast_link_local(),
            Err(_) => false,
        };
        return Some(NetworkPath { kind: if lan { "lan" } else { "direct" }, relay: None });
    }
    if peer.get("Active").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    // A peer relay is another tailnet node carrying the traffic, so there's no DERP region to name.
    let region = text("Relay");
    let relay = (text("PeerRelay").is_empty() && !region.is_empty()).then_some(region);
    Some(NetworkPath { kind: "relay", relay })
}

fn apply_hosts(state: &MachineHealthState, hosts: Vec<MachineHost>) {
    let mut inner = state.lock();
    let local_names = inner.local_names.clone();
    let mut retained = BTreeMap::new();
    for host in hosts {
        let local = is_local_endpoint(&host.endpoint, &local_names);
        let series = match inner.series.remove(&host.machine) {
            Some(mut existing) => {
                if existing.host.endpoint != host.endpoint || existing.host.port != host.port {
                    // A different target is a different history.
                    existing.points.clear();
                    existing.counters = None;
                    existing.facts = None;
                    existing.error = None;
                    existing.last_ok_at = None;
                    existing.last_attempt_at = None;
                    existing.ping_target = None;
                    existing.path = None;
                    existing.agents = agents::MachineAgents::default();
                    existing.transcripts = transcripts::TranscriptScans::default();
                    existing.attention = attention::AttentionLog::default();
                    existing.t3 = t3_threads::T3Log::default();
                    existing.setup = setup::MachineSetup::default();
                }
                existing.host = host;
                existing.local = local;
                existing
            }
            None => MachineSeries::new(host, local),
        };
        retained.insert(series.host.machine.clone(), series);
    }
    inner.series = retained;
}

fn record_result(
    state: &MachineHealthState,
    machine: &str,
    at_ms: i64,
    result: Result<RawSample, String>,
    latency_ms: Option<f32>,
    path: Option<NetworkPath>,
) {
    let mut inner = state.lock();
    let Some(series) = inner.series.get_mut(machine) else {
        return;
    };
    series.last_attempt_at = Some(at_ms);
    series.path = path;
    match result.and_then(|sample| derive_point(&sample, series.counters, at_ms)) {
        Ok((facts, mut point, counters, reason)) => {
            point.latency_ms = latency_ms;
            series.facts = Some(facts);
            series.counters = Some(counters);
            series.reason = reason;
            series.error = None;
            series.last_ok_at = Some(at_ms);
            series.push(point);
        }
        Err(error) => {
            series.error = Some(error);
            series.counters = None;
            series.trim(at_ms);
        }
    }
}

async fn wait_for_tick(state: &MachineHealthState, token: &CancellationToken, interval: Duration) {
    tokio::select! {
        _ = tokio::time::sleep(interval) => {},
        _ = state.notify.notified() => {},
        _ = token.cancelled() => {},
    }
}

async fn sampler_loop(app: tauri::AppHandle, token: CancellationToken) {
    let state = app.state::<MachineHealthState>();
    let mut hosts_loaded_at: Option<Instant> = None;
    let mut ping_targets_resolved: HashMap<String, (MachineHost, Instant)> = HashMap::new();
    loop {
        if token.is_cancelled() {
            return;
        }
        let reload = {
            let inner = state.lock();
            inner.reload_hosts || hosts_loaded_at.is_none_or(|at| at.elapsed() >= HOSTS_REFRESH)
        };
        if reload {
            let loaded = run_usage_task(|| {
                let connection = open_usage_database()?;
                if let Err(error) = agent_homes::reload(&connection) {
                    eprintln!("Failed to read the agent homes: {error}");
                }
                load_hosts(&connection)
            })
            .await;
            match loaded {
                Ok(hosts) => {
                    apply_hosts(&state, hosts);
                    resolve_ping_targets(&state, &mut ping_targets_resolved).await;
                }
                Err(error) => eprintln!("Failed to load machine hosts: {error}"),
            }
            hosts_loaded_at = Some(Instant::now());
            state.lock().reload_hosts = false;
        }
        let targets: Vec<(Machine, Option<String>)> = state
            .lock()
            .series
            .values()
            .filter(|series| series.host.enabled && !series.host.endpoint.trim().is_empty())
            .map(|series| (Machine::listed(series), series.ping_target.clone()))
            .collect();
        let at_ms = Local::now().timestamp_millis();
        let results = futures_util::future::join_all(targets.into_iter().map(|(machine, ping_target)| async move {
            let ping = async {
                match &ping_target {
                    Some(target) => ping_host(target).await,
                    None => PingReading::default(),
                }
            };
            let (sample, ping) = tokio::join!(sample_host(&machine), ping);
            (machine.name().to_string(), sample, ping)
        }))
        .await;
        if token.is_cancelled() {
            return;
        }
        // One status read covers every machine on the tailnet.
        let paths = if results.iter().any(|(_, _, ping)| ping.address.is_some_and(is_tailnet)) {
            state.tailscale_status().await.map(|status| status.paths).unwrap_or_default()
        } else {
            HashMap::new()
        };
        for (machine, result, ping) in results {
            let path = ping.address.and_then(|address| paths.get(&address).cloned());
            record_result(&state, &machine, at_ms, result, ping.latency_ms, path);
        }
        agents::check_due(&app, &state, at_ms);
        runs::after_round(&app, at_ms);
        transcripts::scan_due(&app, &state, at_ms);
        agent_homes::scan_due(&app, &state, at_ms);
        let interval = if state.is_active() { ACTIVE_INTERVAL } else { IDLE_INTERVAL };
        let seq = {
            let mut inner = state.lock();
            inner.seq += 1;
            inner.last_round_at = Some(at_ms);
            inner.interval_ms = interval.as_millis() as u64;
            inner.seq
        };
        let _ = app.emit(MACHINE_HEALTH_UPDATED_EVENT, seq);
        wait_for_tick(&state, &token, interval).await;
    }
}

pub(crate) fn start_machine_health_sampler(app: tauri::AppHandle) {
    let state = app.state::<MachineHealthState>();
    state.lock().local_names = detect_local_names();
    let Some(token) = state.start() else {
        return;
    };
    tauri::async_runtime::spawn(attention::poll_loop(app.clone(), token.clone()));
    tauri::async_runtime::spawn(t3_threads::poll_loop(app.clone(), token.clone()));
    tauri::async_runtime::spawn(automations::poll_loop(app.clone(), token.clone()));
    tauri::async_runtime::spawn(archive::run_loop(app.clone(), token.clone()));
    tauri::async_runtime::spawn(async move {
        sampler_loop(app, token).await;
    });
}

pub(crate) fn stop_machine_health_sampler(app: &tauri::AppHandle) {
    app.state::<MachineHealthState>().stop();
}

// ---------------------------------------------------------------------------
// Host registry (SQLite)
// ---------------------------------------------------------------------------

/// Names compare loosely, so "Build Box" and "build-box" are one machine.
pub(super) fn normalize_machine_name(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Seed a host for every machine an API key is assigned to, with no endpoint yet. Existing rows are never
/// overwritten, so user edits survive re-seeding, and a removed machine's row keeps it from coming back.
pub(super) fn seed_hosts(connection: &Connection) -> Result<(), String> {
    let mut assignment_machines: Vec<String> = machines::read_assignments(connection)?
        .into_iter()
        .map(|assignment| assignment.machine)
        .filter(|machine| !machine.is_empty())
        .collect();
    assignment_machines.sort();
    assignment_machines.dedup();
    let mut insert = connection
        .prepare("INSERT OR IGNORE INTO usage_machine_hosts(machine, endpoint, port, enabled, source) VALUES (?1, '', 22, 1, 'seed')")
        .map_err(|error| error.to_string())?;
    for machine in &assignment_machines {
        insert.execute(params![machine]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn read_hosts(connection: &Connection) -> Result<Vec<MachineHost>, String> {
    let mut statement = connection
        .prepare("SELECT machine, endpoint, port, enabled, source FROM usage_machine_hosts WHERE source != 'removed' ORDER BY machine")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(MachineHost {
                machine: row.get(0)?,
                endpoint: row.get(1)?,
                port: row.get::<_, i64>(2).map(|port| u16::try_from(port).unwrap_or(22))?,
                enabled: row.get::<_, i64>(3)? != 0,
                source: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(super) fn load_hosts(connection: &Connection) -> Result<Vec<MachineHost>, String> {
    seed_hosts(connection)?;
    read_hosts(connection)
}

/// Saves `hosts` and takes `removed` off the list, in one go: a save that fails changes nothing. A machine in both
/// stays, since saving a machine brings it back.
pub(super) fn save_hosts(connection: &mut Connection, hosts: &[MachineHost], removed: &[String]) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for machine in removed {
        remove_host(&transaction, machine)?;
    }
    for host in hosts {
        let machine = host.machine.trim();
        let endpoint = host.endpoint.trim();
        if machine.is_empty() || machine.len() > 100 {
            return Err("Machine names must be between 1 and 100 bytes".into());
        }
        if endpoint.len() > 253 || endpoint.chars().any(char::is_whitespace) {
            return Err(format!("Invalid endpoint for {machine}: use a host name, IP address, or ssh_config alias"));
        }
        if endpoint.starts_with('-') {
            return Err(format!("Invalid endpoint for {machine}: it cannot start with a dash"));
        }
        if host.port == 0 {
            return Err(format!("Invalid port for {machine}"));
        }
        transaction
            .execute(
                "INSERT INTO usage_machine_hosts(machine, endpoint, port, enabled, source) VALUES (?1, ?2, ?3, ?4, 'manual')
                 ON CONFLICT(machine) DO UPDATE SET endpoint = excluded.endpoint, port = excluded.port, enabled = excluded.enabled, source = 'manual'",
                params![machine, endpoint, host.port, host.enabled as i64],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

/// Takes a machine off the list. Its row stays, marked removed, so an API key still assigned to it doesn't seed it
/// back; saving the machine again brings it back. Its sessions and usage are kept under its name.
fn remove_host(connection: &Connection, machine: &str) -> Result<(), String> {
    let removed = connection
        .execute(
            "UPDATE usage_machine_hosts SET source = 'removed' WHERE machine = ?1 AND source != 'removed'",
            params![machine],
        )
        .map_err(|error| error.to_string())?;
    if removed == 0 {
        return Err(format!("No machine called {machine} is on the list"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineHealth {
    machine: String,
    host: MachineHost,
    local: bool,
    status: HealthStatus,
    score: Option<u8>,
    reason: Option<HealthReason>,
    facts: Option<MachineFacts>,
    latest: Option<HealthPoint>,
    points: Vec<HealthPoint>,
    error: Option<String>,
    last_ok_at: Option<i64>,
    last_attempt_at: Option<i64>,
    /// Where pings go, from `ssh -G`. None for this machine or behind a jump host, which aren't pinged.
    ping_target: Option<String>,
    /// Tailscale's current path to the machine; None when it isn't on the tailnet or is idle.
    path: Option<NetworkPath>,
    agents: agents::MachineAgents,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineHealthSnapshot {
    seq: u64,
    now: i64,
    interval_ms: u64,
    sampled_at: Option<i64>,
    history_ms: i64,
    machines: Vec<MachineHealth>,
}

fn build_snapshot(inner: &Inner, now: i64, since: Option<i64>, window_ms: i64) -> MachineHealthSnapshot {
    let floor = now - window_ms.clamp(1_000, HISTORY_MS);
    let machines = inner
        .series
        .values()
        .filter(|series| series.host.enabled)
        .map(|series| {
            let latest = series.points.back().copied();
            let status = if series.host.endpoint.trim().is_empty() {
                HealthStatus::Unconfigured
            } else if series.last_attempt_at.is_none() {
                HealthStatus::Pending
            } else if series.error.is_some() {
                HealthStatus::Unreachable
            } else {
                latest.map_or(HealthStatus::Pending, |point| status_for_score(point.score))
            };
            let points = series
                .points
                .iter()
                .filter(|point| point.t >= floor && since.is_none_or(|since| point.t > since))
                .copied()
                .collect();
            MachineHealth {
                machine: series.host.machine.clone(),
                host: series.host.clone(),
                local: series.local,
                status,
                score: latest.map(|point| point.score),
                reason: series.reason,
                facts: series.facts.clone(),
                latest,
                points,
                error: series.error.clone(),
                last_ok_at: series.last_ok_at,
                last_attempt_at: series.last_attempt_at,
                ping_target: series.ping_target.clone(),
                path: series.path.clone(),
                agents: series.agents.clone(),
            }
        })
        .collect();
    MachineHealthSnapshot {
        seq: inner.seq,
        now,
        interval_ms: inner.interval_ms,
        sampled_at: inner.last_round_at,
        history_ms: HISTORY_MS,
        machines,
    }
}

/// `passive` reads without counting as someone watching, so a background check for alerts
/// doesn't keep the whole fleet on the fast interval.
#[tauri::command]
pub(crate) async fn get_machine_health(
    state: tauri::State<'_, MachineHealthState>,
    since: Option<i64>,
    window_ms: Option<i64>,
    passive: Option<bool>,
) -> Result<MachineHealthSnapshot, String> {
    if passive != Some(true) {
        state.touch();
    }
    let now = Local::now().timestamp_millis();
    let inner = state.lock();
    Ok(build_snapshot(&inner, now, since, window_ms.unwrap_or(HISTORY_MS)))
}

/// This Mac as the machine list names it, or would once it's added, and whether it's there yet.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThisMac {
    /// The name its sessions and setup are filed under.
    name: String,
    /// The machine list has it, under `name`.
    listed: bool,
}

fn this_mac(hosts: &[MachineHost], local_names: &[String]) -> ThisMac {
    match hosts.iter().find(|host| is_local_endpoint(&host.endpoint, local_names)) {
        Some(host) => ThisMac { name: host.machine.clone(), listed: true },
        None => ThisMac { name: local_names.first().cloned().unwrap_or_else(|| "localhost".into()), listed: false },
    }
}

/// Read from the saved list rather than the sampler's, which catches up with a save a moment later.
#[tauri::command]
pub(crate) async fn get_this_mac(state: tauri::State<'_, MachineHealthState>) -> Result<ThisMac, String> {
    let hosts = run_usage_task(|| load_hosts(&open_usage_database()?)).await?;
    let local_names = state.lock().local_names.clone();
    Ok(this_mac(&hosts, &local_names))
}

#[tauri::command]
pub(crate) async fn get_machine_hosts() -> Result<Vec<MachineHost>, String> {
    run_usage_task(|| load_hosts(&open_usage_database()?)).await
}

/// `removed` names machines to take off the list, from Machine hosts' Edit hosts; the other callers only add or update.
#[tauri::command]
pub(crate) async fn save_machine_hosts(
    state: tauri::State<'_, MachineHealthState>,
    hosts: Vec<MachineHost>,
    removed: Option<Vec<String>>,
) -> Result<Vec<MachineHost>, String> {
    let saved = run_usage_task(move || {
        let mut connection = open_usage_database()?;
        save_hosts(&mut connection, &hosts, &removed.unwrap_or_default())?;
        read_hosts(&connection)
    })
    .await?;
    state.request_reload();
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_mac_is_the_listed_local_host_or_else_the_name_its_things_are_filed_under() {
        let host = |machine: &str, endpoint: &str| MachineHost { machine: machine.into(), endpoint: endpoint.into(), port: 22, enabled: true, source: String::new() };
        let names = vec!["studio-mac".to_string(), "studio-mac.local".to_string()];
        assert_eq!(this_mac(&[host("cedar-01", "cedar-01.lan")], &names), ThisMac { name: "studio-mac".into(), listed: false });
        assert_eq!(this_mac(&[host("cedar-01", "cedar-01.lan"), host("desk", "localhost")], &names), ThisMac { name: "desk".into(), listed: true });
        assert_eq!(this_mac(&[host("desk", "studio-mac.local")], &names), ThisMac { name: "desk".into(), listed: true });
        assert_eq!(this_mac(&[], &[]), ThisMac { name: "localhost".into(), listed: false });
    }

    const LINUX_SAMPLE: &str = "hostname=cedar-01\nos=Linux\narch=x86_64\ncores=24\nload1=0.5\nload5=0.4\nload15=0.3\nmem_total_kb=64308204\nmem_available_kb=58275816\ndisk_total_kb=982292956\ndisk_used_kb=222783264\nnet_rx_bytes=1000\nnet_tx_bytes=2000\ncpu_pct=4.6\ncpu_total_jiffies=1000\ncpu_idle_jiffies=900\nchip=12th Gen Intel(R) Core(TM) i9-12900K\nmodel=MS-7D25\ngpu_name=NVIDIA Corporation GA102 [GeForce RTX 3080]\nos_version=Ubuntu 26.04 LTS\nswap_total_kb=33554424\nswap_used_kb=1576564\ncpu_temp_c=26.0\nuptime_s=860270\n";

    #[test]
    fn idle_machine_scores_full_health_without_a_reason() {
        let (score, reason) = assess(HealthInputs {
            cpu: Some(12.0),
            mem: 40.0,
            swap: Some(5.0),
            disk: 50.0,
            load_per_core: 0.2,
            cpu_temp: Some(45.0),
            gpu_temp: None,
        });
        assert_eq!(score, 100);
        assert!(reason.is_none());
    }

    #[test]
    fn a_full_disk_alone_degrades_and_names_disk() {
        let (score, reason) = assess(HealthInputs {
            disk: 91.0,
            mem: 30.0,
            ..HealthInputs::default()
        });
        assert!(score < 90 && score >= 75, "score was {score}");
        assert_eq!(reason.map(|r| r.metric), Some(HealthMetric::Disk));
        assert_eq!(status_for_score(score), HealthStatus::Healthy);
        let (critical, reason) = assess(HealthInputs {
            disk: 99.0,
            mem: 97.0,
            swap: Some(95.0),
            cpu: Some(100.0),
            ..HealthInputs::default()
        });
        assert_eq!(critical, 0);
        assert_eq!(status_for_score(critical), HealthStatus::Critical);
        assert!(matches!(reason.map(|r| r.metric), Some(HealthMetric::Cpu | HealthMetric::Memory)));
    }

    #[test]
    fn unknown_sensors_never_penalize() {
        let (score, _) = assess(HealthInputs {
            cpu: None,
            swap: None,
            cpu_temp: None,
            gpu_temp: None,
            mem: 10.0,
            disk: 10.0,
            load_per_core: 0.0,
        });
        assert_eq!(score, 100);
    }

    #[test]
    fn linux_cpu_prefers_counter_deltas_once_two_readings_exist() {
        let sample = RawSample::parse(LINUX_SAMPLE).unwrap();
        let (facts, first, counters, _) = derive_point(&sample, None, 10_000).unwrap();
        assert_eq!(first.cpu, Some(4.6));
        assert_eq!(first.rx_bps, None);
        assert_eq!(facts.cores, 24);
        assert_eq!(facts.gpu, "NVIDIA Corporation GA102 [GeForce RTX 3080]");
        assert_eq!(facts.swap_total_kb, Some(33554424));
        assert_eq!(first.swap, Some(4.7));
        assert_eq!(first.disk, 22.7);
        assert_eq!(first.mem, 9.4);

        let later = LINUX_SAMPLE
            .replace("cpu_total_jiffies=1000", "cpu_total_jiffies=1400")
            .replace("cpu_idle_jiffies=900", "cpu_idle_jiffies=1000")
            .replace("net_rx_bytes=1000", "net_rx_bytes=6000")
            .replace("net_tx_bytes=2000", "net_tx_bytes=1000");
        let sample = RawSample::parse(&later).unwrap();
        let (_, second, _, _) = derive_point(&sample, Some(counters), 15_000).unwrap();
        assert_eq!(second.cpu, Some(75.0));
        assert_eq!(second.rx_bps, Some(1000.0));
        assert_eq!(second.tx_bps, None, "counter reset renders as unknown");
    }

    #[test]
    fn samples_missing_core_readings_are_rejected() {
        let error = RawSample::parse("hostname=x\nos=Linux\n").unwrap_err();
        assert!(error.contains("missing arch"), "{error}");
    }

    #[test]
    fn ring_is_bounded_by_count_and_age() {
        let host = MachineHost { machine: "m".into(), endpoint: "m".into(), port: 22, enabled: true, source: String::new() };
        let mut series = MachineSeries::new(host, false);
        let base = 10 * HISTORY_MS;
        let mut point = HealthPoint {
            t: 0, score: 100, cpu: None, mem: 0.0, mem_used_kb: 0, swap: None, swap_used_kb: None, disk: 0.0,
            disk_free_kb: 0, load1: 0.0, load5: 0.0, load15: 0.0, rx_bps: None, tx_bps: None, latency_ms: None,
            cpu_temp: None, gpu_temp: None, gpu_util: None, gpu_mem_used_mb: None, claude_running: None, codex_running: None,
        };
        for index in 0..(MAX_POINTS as i64 + 50) {
            point.t = base + index * 1_000;
            series.push(point);
        }
        assert_eq!(series.points.len(), MAX_POINTS);
        point.t = base + 3 * HISTORY_MS;
        series.push(point);
        assert_eq!(series.points.len(), 1);
    }

    #[test]
    fn local_endpoints_are_detected_loosely() {
        let names = vec!["caseys-mac-mini-2".to_string(), "caseys-mac-mini-2.local".to_string()];
        assert!(is_local_endpoint("localhost", &names));
        assert!(is_local_endpoint("Caseys-Mac-mini-2.local", &names));
        assert!(is_local_endpoint("caseys-mac-mini-2", &names));
        assert!(!is_local_endpoint("cedar-01", &names));
    }

    #[test]
    fn hosts_seed_from_assignments_without_overwriting_edits() {
        let mut connection = schema::test_database();
        connection
            .execute(
                "INSERT INTO usage_machine_assignments VALUES ('a','one','Mac Mini','Local'),('b','two','Cedar 01','Cedar'),('c','three','Mystery',''),('d','four','','')",
                [],
            )
            .unwrap();
        seed_hosts(&connection).unwrap();
        let hosts = read_hosts(&connection).unwrap();
        let by_name: HashMap<_, _> = hosts.iter().map(|host| (host.machine.as_str(), host)).collect();
        assert_eq!(hosts.len(), 3);
        assert_eq!((by_name["Cedar 01"].endpoint.as_str(), by_name["Cedar 01"].port), ("", 22));
        assert_eq!(by_name["Mystery"].source, "seed");

        let mut edited = by_name["Mystery"].clone();
        edited.endpoint = "mystery.lan".into();
        edited.enabled = false;
        save_hosts(&mut connection, std::slice::from_ref(&edited), &[]).unwrap();
        seed_hosts(&connection).unwrap();
        let mystery = read_hosts(&connection)
            .unwrap()
            .into_iter()
            .find(|host| host.machine == "Mystery")
            .unwrap();
        assert_eq!(mystery.endpoint, "mystery.lan");
        assert!(!mystery.enabled);
        assert_eq!(mystery.source, "manual");

        let bad = MachineHost { machine: "x".into(), endpoint: "-oProxyCommand=evil".into(), port: 22, enabled: true, source: String::new() };
        assert!(save_hosts(&mut connection, &[bad], &[]).is_err());
        let spaced = MachineHost { machine: "x".into(), endpoint: "host name".into(), port: 22, enabled: true, source: String::new() };
        assert!(save_hosts(&mut connection, &[spaced], &[]).is_err());
    }

    #[test]
    fn a_removed_machine_stays_off_the_list_until_it_is_saved_again() {
        let mut connection = schema::test_database();
        connection
            .execute("INSERT INTO usage_machine_assignments VALUES ('a','one','Cedar 01','')", [])
            .unwrap();
        let names = |connection: &Connection| read_hosts(connection).unwrap().into_iter().map(|host| host.machine).collect::<Vec<_>>();
        let desk = MachineHost { machine: "desk".into(), endpoint: "localhost".into(), port: 22, enabled: true, source: String::new() };
        save_hosts(&mut connection, std::slice::from_ref(&desk), &[]).unwrap();
        assert_eq!(load_hosts(&connection).unwrap().len(), 2);

        // A save that fails takes nothing off.
        let bad = MachineHost { machine: "desk".into(), endpoint: "-oProxyCommand=evil".into(), ..desk.clone() };
        assert!(save_hosts(&mut connection, &[bad], &["Cedar 01".into()]).is_err());
        assert_eq!(names(&connection), ["Cedar 01", "desk"]);

        save_hosts(&mut connection, &[], &["Cedar 01".into(), "desk".into()]).unwrap();
        // The API key is still assigned to Cedar 01, and the next load seeds again.
        assert!(load_hosts(&connection).unwrap().is_empty());
        assert!(save_hosts(&mut connection, &[], &["desk".into()]).is_err(), "already removed");
        assert!(save_hosts(&mut connection, &[], &["nowhere".into()]).is_err());

        save_hosts(&mut connection, &[desk], &[]).unwrap();
        let back = read_hosts(&connection).unwrap();
        assert_eq!(names(&connection), ["desk"]);
        assert_eq!((back[0].endpoint.as_str(), back[0].source.as_str()), ("localhost", "manual"));
    }

    #[test]
    fn snapshot_reports_status_and_incremental_points() {
        let state = MachineHealthState::default();
        apply_hosts(
            &state,
            vec![
                MachineHost { machine: "up".into(), endpoint: "up".into(), port: 22, enabled: true, source: String::new() },
                MachineHost { machine: "blank".into(), endpoint: String::new(), port: 22, enabled: true, source: String::new() },
                MachineHost { machine: "hidden".into(), endpoint: "hidden".into(), port: 22, enabled: false, source: String::new() },
            ],
        );
        let sample = RawSample::parse(LINUX_SAMPLE).unwrap();
        let lan = NetworkPath { kind: "lan", relay: None };
        record_result(&state, "up", 1_000, Ok(sample.clone()), Some(5.5), Some(lan.clone()));
        record_result(&state, "up", 6_000, Ok(sample), Some(6.5), Some(lan.clone()));
        let inner = state.lock();
        let snapshot = build_snapshot(&inner, 6_000, None, HISTORY_MS);
        assert_eq!(snapshot.machines.len(), 2);
        let up = snapshot.machines.iter().find(|m| m.machine == "up").unwrap();
        assert_eq!(up.status, HealthStatus::Healthy);
        assert_eq!(up.points.len(), 2);
        assert_eq!(up.score, Some(100), "latency never counts toward the score");
        assert_eq!(up.latest.and_then(|point| point.latency_ms), Some(6.5));
        assert_eq!(up.path, Some(lan));
        let blank = snapshot.machines.iter().find(|m| m.machine == "blank").unwrap();
        assert_eq!(blank.status, HealthStatus::Unconfigured);
        let incremental = build_snapshot(&inner, 6_000, Some(1_000), HISTORY_MS);
        assert_eq!(incremental.machines.iter().find(|m| m.machine == "up").unwrap().points.len(), 1);
        drop(inner);
        record_result(&state, "up", 11_000, Err("ssh: connect refused".into()), None, None);
        let inner = state.lock();
        let snapshot = build_snapshot(&inner, 11_000, None, HISTORY_MS);
        let up = snapshot.machines.iter().find(|m| m.machine == "up").unwrap();
        assert_eq!(up.status, HealthStatus::Unreachable);
        assert_eq!(up.points.len(), 2, "history survives a failed round");
        assert_eq!(up.error.as_deref(), Some("ssh: connect refused"));
    }

    #[cfg(unix)]
    #[test]
    fn local_sampling_runs_the_real_script_end_to_end() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let here = Machine::this_mac("here");
        let first = runtime.block_on(sample_host(&here)).unwrap();
        let (facts, point, counters, _) = derive_point(&first, None, 1_000).unwrap();
        assert!(!facts.hostname.is_empty());
        assert!(facts.cores >= 1);
        assert!(facts.mem_total_kb > 0);
        assert!(point.mem > 0.0 && point.mem <= 100.0, "mem {}", point.mem);
        assert!(point.disk > 0.0 && point.disk <= 100.0, "disk {}", point.disk);
        assert!(point.claude_running.is_some() && point.codex_running.is_some(), "agents are counted, even when none run");
        let second = runtime.block_on(sample_host(&here)).unwrap();
        let (_, later, _, _) = derive_point(&second, Some(counters), 2_000).unwrap();
        assert!(later.rx_bps.is_some(), "second sample derives a network rate");
        assert!(later.cpu.is_some_and(|cpu| (0.0..=100.0).contains(&cpu)));
    }

    #[cfg(unix)]
    #[test]
    fn running_agents_are_counted_by_how_they_were_started() {
        use std::io::Write;
        let marker = "ps -A -ww -o args= 2>/dev/null | awk '";
        let start = SAMPLE_SCRIPT.find(marker).unwrap() + marker.len();
        let program = &SAMPLE_SCRIPT[start..start + SAMPLE_SCRIPT[start..].find("' || true)").unwrap()];
        let processes = [
            // Claude Code: native, by its version-named build, through Node, and driven by an SDK.
            "/Users/casey/.local/bin/claude --dangerously-skip-permissions",
            "/Users/casey/.local/share/claude/versions/2.1.281 --resume",
            "node /usr/local/bin/claude",
            "/usr/bin/node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi",
            "claude --output-format stream-json --verbose",
            // Not sessions: the browser bridge, the desktop app and anything merely named after it.
            "claude --chrome-native-host chrome-extension://abc/",
            "/Applications/Claude.app/Contents/MacOS/Claude",
            "vim claude.md",
            // Codex: the native binary however it was installed. Its Node wrapper would count twice.
            "codex -c model=\"gpt-5\" app-server",
            "/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex exec",
            "node /opt/homebrew/bin/codex",
            "/Applications/Codex.app/Contents/MacOS/Codex",
            "codex-code-mode-host",
            "[kthreadd]",
        ]
        .join("\n");
        let mut child = std::process::Command::new("awk")
            .arg(program)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(processes.as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "5 2");
    }

    /// Runs the sample script's awk program that reads `key` out of ioreg's output.
    #[cfg(unix)]
    fn ioreg_value(key: &str, ioreg: &str) -> String {
        use std::io::Write;
        let marker = "awk -F'\"' '";
        let start = SAMPLE_SCRIPT.find(&format!("{marker}$2 == \"{key}\"")).unwrap() + marker.len();
        let program = &SAMPLE_SCRIPT[start..start + SAMPLE_SCRIPT[start..].find("' ||").unwrap()];
        let mut child = std::process::Command::new("awk")
            .arg("-F\"")
            .arg(program)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(ioreg.as_bytes()).unwrap();
        String::from_utf8_lossy(&child.wait_with_output().unwrap().stdout).into_owned()
    }

    #[cfg(unix)]
    #[test]
    fn a_mac_names_its_model_and_nothing_else_ioreg_prints() {
        let platform = r#"+-o J614sAP  <class IOPlatformExpertDevice, id 0x100000208, registered, matched, active, busy 0 (1026 ms), retain 40>
    {
      "compatible" = <"J614sAP","MacBookPro18,2","AppleARM">
      "IOPlatformUUID" = "7A3C1C5E-6E7B-5B87-9A2C-0123456789AB"
      "manufacturer" = <"Apple Inc.">
      "IOPlatformSerialNumber" = "C02XK1234567"
      "model-number" = <"Z1FF0001UA/A">
      "model" = <"Mac16,8">
      "target-type" = <"J614s">
    }
"#;
        assert_eq!(ioreg_value("model", platform), "Mac16,8\n", "not the model number, the serial or the UUID");
        let product = r#"+-o product  <class IOService, id 0x100000213, registered, matched, active, busy 0 (0 ms), retain 7>
    {
      "product-soc-id" = <"t6040">
      "product-name" = <"MacBook Pro (14-inch, 2024)">
      "product-description" = <"MacBook Pro with M4 Pro">
    }
"#;
        assert_eq!(ioreg_value("product-name", product), "MacBook Pro (14-inch, 2024)\n");
        assert_eq!(ioreg_value("product-name", ""), "", "an Intel Mac has no product node");

        let sample = RawSample::parse(&format!("{LINUX_SAMPLE}model=Mac16,8\nproduct_name=MacBook Pro (14-inch, 2024)\n")).unwrap();
        let (facts, ..) = derive_point(&sample, None, 1_000).unwrap();
        assert_eq!((facts.model.as_str(), facts.product_name.as_str()), ("Mac16,8", "MacBook Pro (14-inch, 2024)"));
    }

    #[test]
    fn ping_output_gives_the_address_and_the_median_round_trip() {
        let mac = "PING cedar-01.tailc0ffee.ts.net (100.64.0.21): 56 data bytes\n\
            64 bytes from 100.64.0.21: icmp_seq=0 ttl=64 time=5.733 ms\n\
            64 bytes from 100.64.0.21: icmp_seq=1 ttl=64 time=123.634 ms\n\
            64 bytes from 100.64.0.21: icmp_seq=2 ttl=64 time=6.1 ms\n\n\
            --- cedar-01.tailc0ffee.ts.net ping statistics ---\n\
            3 packets transmitted, 3 packets received, 0.0% packet loss\n\
            round-trip min/avg/max/stddev = 5.733/45.156/123.634/55.3 ms\n";
        let reading = parse_ping("cedar-01.tailc0ffee.ts.net", mac);
        assert_eq!(reading.address, Some(IpAddr::from([100, 64, 0, 21])));
        assert_eq!(reading.latency_ms, Some(6.1), "one slow reply doesn't move the median");

        let linux = "PING cedar-02(fd7a:115c:a1e0::a17 (fd7a:115c:a1e0::a17)) 56 data bytes\n\
            64 bytes from fd7a:115c:a1e0::a17: icmp_seq=1 ttl=64 time=6.00 ms\n\
            64 bytes from fd7a:115c:a1e0::a17: icmp_seq=3 ttl=64 time=7.00 ms\n\n\
            3 packets transmitted, 2 received, 33.3333% packet loss, time 402ms\n";
        let reading = parse_ping("cedar-02", linux);
        assert_eq!(reading.address, Some("fd7a:115c:a1e0::a17".parse().unwrap()));
        assert_eq!(reading.latency_ms, Some(6.5));

        let windows = "Pinging casey-macbook-air [100.64.0.22] with 32 bytes of data:\r\n\
            Reply from 100.64.0.22: bytes=32 time=39ms TTL=64\r\n\
            Reply from 100.64.0.22: bytes=32 time<1ms TTL=64\r\n\
            Reply from 100.64.0.22: bytes=32 time=41ms TTL=64\r\n";
        let reading = parse_ping("casey-macbook-air", windows);
        assert_eq!(reading.address, Some(IpAddr::from([100, 64, 0, 22])));
        assert_eq!(reading.latency_ms, Some(39.0));

        let silent = "PING cedar-01.tailc0ffee.ts.net (100.64.0.21): 56 data bytes\n\
            Request timeout for icmp_seq 0\n\n3 packets transmitted, 0 packets received, 100.0% packet loss\n";
        assert_eq!(
            parse_ping("cedar-01.tailc0ffee.ts.net", silent),
            PingReading { address: Some(IpAddr::from([100, 64, 0, 21])), latency_ms: None },
        );
        assert_eq!(parse_ping("nowhere", ""), PingReading::default());
        assert_eq!(parse_ping("100.64.0.22", "Pinging 100.64.0.22 with 32 bytes of data:\r\nRequest timed out.\r\n").address, Some(IpAddr::from([100, 64, 0, 22])));
    }

    #[test]
    fn ssh_config_names_the_ping_target_unless_a_proxy_sits_in_between() {
        let config = "host cedar-01\nhostname cedar-01.tailc0ffee.ts.net\nport 22\nuser casey\nproxycommand none\n";
        assert_eq!(ping_target_from_ssh_config(config).as_deref(), Some("cedar-01.tailc0ffee.ts.net"));
        assert_eq!(ping_target_from_ssh_config(&format!("{config}proxyjump bastion\n")), None);
        assert_eq!(ping_target_from_ssh_config("hostname cedar\nproxycommand ssh -W %h:%p bastion\n"), None);
        assert_eq!(ping_target_from_ssh_config("hostname -oProxyCommand=x\n"), None);
        assert_eq!(ping_target_from_ssh_config("user casey\n"), None);
    }

    #[test]
    fn tailscale_status_tells_lan_internet_and_relayed_peers_apart() {
        let status = serde_json::json!({
            "Peer": {
                "lan": { "TailscaleIPs": ["100.64.0.21", "fd7a:115c:a1e0::b21"], "CurAddr": "192.168.1.26:41641", "Relay": "syd", "Online": true, "Active": true },
                "away": { "TailscaleIPs": ["100.64.0.22"], "CurAddr": "203.0.113.9:41641", "Relay": "syd", "Online": true, "Active": true },
                "derp": { "TailscaleIPs": ["100.64.0.23"], "CurAddr": "", "Relay": "syd", "PeerRelay": "", "Online": true, "Active": true },
                "peerRelay": { "TailscaleIPs": ["100.64.0.9"], "CurAddr": "", "Relay": "sfo", "PeerRelay": "100.64.0.2:7777", "Online": true, "Active": true },
                "idle": { "TailscaleIPs": ["100.64.0.10"], "CurAddr": "", "Relay": "syd", "Online": true, "Active": false },
                "offline": { "TailscaleIPs": ["100.64.0.11"], "CurAddr": "192.168.1.9:41641", "Online": false, "Active": false },
                "linkLocal": { "TailscaleIPs": ["100.64.0.12"], "CurAddr": "[fe80::1%en0]:41641", "Online": true, "Active": true },
                "v6": { "TailscaleIPs": ["100.64.0.13"], "CurAddr": "[2001:db8::1]:41641", "Online": true, "Active": true }
            }
        });
        let paths = paths_from_status(&status);
        let path = |ip: &str| paths.get(&ip.parse::<IpAddr>().unwrap()).cloned();
        let lan = Some(NetworkPath { kind: "lan", relay: None });
        let direct = Some(NetworkPath { kind: "direct", relay: None });
        assert_eq!(path("100.64.0.21"), lan);
        assert_eq!(path("fd7a:115c:a1e0::b21"), lan, "every tailnet address maps to the peer");
        assert_eq!(path("100.64.0.22"), direct);
        assert_eq!(path("100.64.0.23"), Some(NetworkPath { kind: "relay", relay: Some("syd".into()) }));
        assert_eq!(path("100.64.0.9"), Some(NetworkPath { kind: "relay", relay: None }), "a peer relay has no DERP region");
        assert_eq!(path("100.64.0.10"), None, "an idle peer has no current path");
        assert_eq!(path("100.64.0.11"), None, "an offline peer has no current path");
        assert_eq!(path("100.64.0.12"), lan);
        assert_eq!(path("100.64.0.13"), direct);
        assert!(paths_from_status(&serde_json::json!({ "BackendState": "Stopped" })).is_empty());
    }

    #[test]
    fn tailscale_status_is_read_once_a_minute_and_a_failed_read_retried_sooner_then_less_often() {
        use std::cell::Cell;
        let start = Instant::now();
        let now = Cell::new(start);
        let reads = Cell::new(0);
        let mut cache = TailscaleCache::new(|| now.get());
        let paths = |kind: &'static str| HashMap::from([(IpAddr::from([100, 64, 0, 1]), NetworkPath { kind, relay: None })]);
        let read = |result: Option<HashMap<IpAddr, NetworkPath>>| {
            reads.set(reads.get() + 1);
            std::future::ready(result)
        };
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let mut at = |seconds: u64, result: Option<HashMap<IpAddr, NetworkPath>>| {
            now.set(start + Duration::from_secs(seconds));
            runtime.block_on(cache.get(|| read(result))).unwrap_or_default()
        };

        assert_eq!(at(0, Some(paths("lan"))), paths("lan"));
        assert_eq!(at(59, Some(paths("direct"))), paths("lan"), "a read is reused for a minute");
        assert_eq!(reads.get(), 1);
        assert_eq!(at(60, Some(paths("direct"))), paths("direct"));
        assert_eq!(at(61, None), paths("direct"), "still fresh, so the failing read isn't made");
        assert_eq!(reads.get(), 2);
        assert_eq!(at(120, None), HashMap::new(), "a failed read leaves no paths");
        assert_eq!(at(129, Some(paths("lan"))), HashMap::new());
        assert_eq!(reads.get(), 3, "a failure is kept for a few seconds");
        assert_eq!(at(130, Some(paths("lan"))), paths("lan"), "and then tried again");
        assert_eq!(reads.get(), 4);

        // One that keeps failing, as while macOS's prompt is up, is tried less often each time,
        // then once a minute.
        assert_eq!(at(190, None), HashMap::new());
        assert_eq!(at(199, Some(paths("lan"))), HashMap::new());
        assert_eq!(at(200, None), HashMap::new(), "the first failure is kept for 10 s");
        assert_eq!(reads.get(), 6);
        assert_eq!(at(229, Some(paths("lan"))), HashMap::new());
        assert_eq!(at(230, None), HashMap::new(), "the second for 30 s");
        assert_eq!(reads.get(), 7);
        assert_eq!(at(289, Some(paths("lan"))), HashMap::new());
        assert_eq!(at(290, None), HashMap::new(), "the third for a minute");
        assert_eq!(at(349, Some(paths("lan"))), HashMap::new());
        assert_eq!(reads.get(), 8, "and so is every one after it");
        assert_eq!(at(350, Some(paths("direct"))), paths("direct"));
        assert_eq!(reads.get(), 9);

        // A good read starts the count again.
        assert_eq!(at(410, None), HashMap::new());
        assert_eq!(at(419, Some(paths("lan"))), HashMap::new());
        assert_eq!(at(420, Some(paths("lan"))), paths("lan"));
        assert_eq!(reads.get(), 11);
    }

    #[test]
    fn tailnet_addresses_are_recognized() {
        for (address, expected) in [
            ("100.64.0.21", true),
            ("100.64.0.1", true),
            ("100.127.255.254", true),
            ("100.63.255.255", false),
            ("100.128.0.1", false),
            ("192.168.1.26", false),
            ("fd7a:115c:a1e0::b21", true),
            ("fd7a:115c:a1e1::1", false),
        ] {
            assert_eq!(is_tailnet(address.parse().unwrap()), expected, "{address}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn pinging_this_machine_measures_a_round_trip() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let reading = runtime.block_on(ping_host("127.0.0.1"));
        assert_eq!(reading.address, Some(IpAddr::from([127, 0, 0, 1])));
        assert!(reading.latency_ms.is_some_and(|ms| (0.0..50.0).contains(&ms)), "{reading:?}");
    }
}
