//! `arbor help <command>` and `arbor <command> --help`: one command's usage with examples, so nobody (person or agent)
//! has to guess from the full list.

/// Each command's own help, by its first word.
const TOPICS: &[(&str, &str)] = &[
    (
        "status",
        "arbor status

The proxy, machine health, live sessions, unread alerts and accounts that are off or nearly out. Running arbor with
no command does the same.

  arbor status
  arbor status --json
",
    ),
    (
        "machines",
        "arbor machines [name]

Every machine's health, or one machine in full (as JSON). A machine can be named by its name or its SSH host, in any
case.

  arbor machines
  arbor machines casey-mbp
",
    ),
    (
        "pools",
        "arbor pools

Each machine pool, who would most likely take its next run, and why each other member couldn't now (full, busy, not
answering). Pools are made and changed in Arbor's Settings › Pools.

  arbor pools
  arbor pools --json
",
    ),
    (
        "sessions",
        "arbor sessions [--live]

Recent agent sessions, or with --live the ones running now and what they cost an hour.

  arbor sessions
  arbor sessions --live
",
    ),
    (
        "usage",
        "arbor usage [today|7d|30d]

Requests, tokens and cost over the range (today when left out).

  arbor usage
  arbor usage 7d --json
",
    ),
    (
        "accounts",
        "arbor accounts [refresh]
arbor accounts pause|resume <account>
arbor accounts cap <account> <percent|off>

Signed-in accounts and their limits; refresh reads the limits again. An account is named by the short id in the first
column (like a6bd830). Pausing asks first: it prints the plan and needs --yes. A cap pauses the account once it has
used that percent of its limits and resumes it at the reset.

  arbor accounts
  arbor accounts refresh
  arbor accounts pause a6bd830           (prints the plan)
  arbor accounts pause a6bd830 --yes
  arbor accounts cap a6bd830 80
  arbor accounts cap a6bd830 off
",
    ),
    (
        "routing",
        "arbor routing [<provider> on|off]

Whether Arbor orders each provider's accounts by their limits automatically, or turns that on or off for one.

  arbor routing
  arbor routing claude on
  arbor routing codex off
",
    ),
    (
        "alerts",
        "arbor alerts [seen]

Recent alerts, or mark every one seen (asks first, so it needs --yes).

  arbor alerts
  arbor alerts seen --yes
",
    ),
    (
        "sync",
        "arbor sync
arbor sync <machine>
arbor sync apply <machine>

How far each machine is from the setup repo, what Sync would change on one, or bring one in line. Applying asks
first: it prints the plan and needs --yes. Every file is backed up before it changes, and Sync › Arbor's changes can
undo it.

  arbor sync
  arbor sync casey-mbp
  arbor sync apply casey-mbp             (prints the plan)
  arbor sync apply casey-mbp --yes
",
    ),
    (
        "core",
        "arbor core [status|start|stop|restart|install [version]]

The proxy core's status, or start, stop, restart or install it. Everything but status asks first and needs --yes;
stopping or restarting cuts off every agent using the proxy for a moment, on every machine.

  arbor core
  arbor core restart                     (prints the plan)
  arbor core restart --yes
  arbor core install                     (the latest release)
",
    ),
    (
        "archive",
        "arbor archive

The session archive: where its store is, how much it holds and when it last collected.

  arbor archive
",
    ),
    (
        "settings",
        "arbor settings
arbor settings get <name>
arbor settings set <name> <value>
arbor settings unset <name>

Arbor's saved settings, by name. A value is read as JSON when it can be.

  arbor settings
  arbor settings get arbor.routing-auto.v1
",
    ),
    (
        "commands",
        "arbor commands [filter]

Everything arbor can call, with its arguments and whether it reads, changes or asks first.

  arbor commands
  arbor commands machine
",
    ),
    (
        "call",
        "arbor call <command> [name=value…] [--args JSON]

Calls any command from arbor commands directly and prints its answer as JSON. Values are read as JSON when they can
be; dashed names become the app's names (window-ms is windowMs). One that asks first needs --yes.

  arbor call get_machine_health passive=true
  arbor call get_usage_overview --args '{\"range\":\"7d\"}'
",
    ),
    (
        "watch",
        "arbor watch [event…]

Prints Arbor's events as they happen, every one or just those named, until stopped.

  arbor watch
  arbor watch saved-store-changed --json
",
    ),
    (
        "mcp",
        "arbor mcp [--read-only]

Serves Arbor to an agent over MCP on stdin and stdout. Changes that ask first need confirm: true from the agent;
--read-only leaves out every change.

  arbor mcp
  arbor mcp --read-only
",
    ),
    (
        "skill",
        "arbor skill
arbor skill install

Prints the skill that teaches agents arbor, or puts it in this Mac's skill store (~/.agents/skills) and each Claude
Code home with Sync on. Each copy is backed up first, so Sync › Arbor's changes can undo it.

  arbor skill
  arbor skill install
",
    ),
    (
        "install",
        "arbor install

Links arbor into ~/.local/bin, pointing at the Arbor in Applications.

  arbor install
",
    ),
    (
        "doctor",
        "arbor doctor

Checks that arbor can reach Arbor: the socket, the app's answer and its window.

  arbor doctor
",
    ),
    ("version", "arbor version\n\nThe version of arbor, which is Arbor's.\n\n  arbor version\n"),
];

/// The help for a command, by its first word.
pub(crate) fn topic(command: &str) -> Option<&'static str> {
    TOPICS.iter().find(|(name, _)| *name == command).map(|(_, text)| *text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_in_the_list_has_its_own_help() {
        for (name, text) in TOPICS {
            assert!(text.starts_with(&format!("arbor {name}")), "{name}'s help starts with its usage");
            assert!(super::super::client::HELP.contains(&format!("\n  {name}")), "{name} is in arbor help");
        }
        for line in super::super::client::HELP.lines().filter(|line| line.starts_with("  ") && !line.starts_with("   ")) {
            let Some(name) = line.split_whitespace().next() else { continue };
            if !name.starts_with('-') && name != "help" {
                assert!(topic(name).is_some(), "arbor help {name} has a topic");
            }
        }
    }
}
