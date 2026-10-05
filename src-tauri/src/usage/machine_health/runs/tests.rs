use super::*;

const PROMPT: &str = "Fix the flaky test in 'billing' and say \"done\" $HOME `id`";
const TOKEN: &str = "t3-session-secret-token";

fn request(harness: Harness, setup: &str) -> RunRequest {
    RunRequest {
        pool: "builds".into(),
        harness,
        setup: setup.into(),
        folder: "~/src/app".into(),
        repo: None,
        worktree: false,
        prompt: PROMPT.into(),
        model: None,
        fallback: false,
        title: None,
        trigger: None,
    }
}

fn run(id: &str, state: RunState) -> HarnessRun {
    HarnessRun {
        id: id.into(),
        trigger: None,
        pool: "builds".into(),
        ran_pool: Some("builds".into()),
        machine: Some("cam-mbp".into()),
        harness: Harness::Headless,
        used: Some(Harness::Headless),
        setup: "claude".into(),
        folder: "~/src/app".into(),
        repo: None,
        title: "Fix the flaky test".into(),
        state,
        reason: None,
        detail: None,
        handle: RunHandle { pid: Some(4242), ..RunHandle::default() },
        queued_at_ms: 1_000,
        started_at_ms: Some(2_000),
        ended_at_ms: None,
        wait_until_ms: None,
    }
}

#[test]
fn a_folder_starts_at_home_or_root_and_never_climbs_out() {
    assert_eq!(checked_folder("~/src/app/").unwrap(), "~/src/app");
    assert_eq!(checked_folder("/srv/app").unwrap(), "/srv/app");
    assert_eq!(checked_folder("/").unwrap(), "/");
    assert!(checked_folder("src/app").is_err());
    assert!(checked_folder("~/src/../../etc").is_err());
    assert!(checked_folder("~/src\napp").is_err());
    assert_eq!(folder_line("~"), "folder=\"$HOME\"\n");
    assert_eq!(folder_line("~/src/it's"), "folder=\"$HOME\"/'src/it'\\''s'\n");
}

#[test]
fn a_title_is_the_one_given_or_the_prompts_first_line() {
    let mut asked = request(Harness::T3, "codex");
    asked.prompt = "\n  Tidy the README\nand more".into();
    assert_eq!(title_of(&asked), "Tidy the README");
    asked.title = Some("Nightly tidy".into());
    assert_eq!(title_of(&asked), "Nightly tidy");
    asked.title = Some("  ".into());
    asked.prompt = " ".into();
    assert_eq!(title_of(&asked), "Arbor run");
}

#[test]
fn ids_are_v4_uuids() {
    let id = new_uuid();
    assert_eq!(id.len(), 36);
    assert_eq!(id.as_bytes()[14], b'4');
    assert_ne!(id, new_uuid());
}

#[test]
fn a_setup_falls_back_to_its_agents_command_line() {
    assert_eq!(agent_for(Harness::T3, "codex_work", Some("codex")), Some(AgentKind::Codex));
    assert_eq!(agent_for(Harness::T3, "claudeAgent", None), Some(AgentKind::Claude));
    assert_eq!(agent_for(Harness::Orca, "claude", None), Some(AgentKind::Claude));
    assert_eq!(agent_for(Harness::Orca, "gemini", None), None);
}

#[test]
fn a_hand_off_reads_back_ids_or_a_plain_failure_code() {
    let handle = parse_hand_off("project_id=p-1\nthread_id=t-1\n").unwrap();
    assert_eq!((handle.project_id.as_deref(), handle.thread_id.as_deref()), (Some("p-1"), Some("t-1")));
    assert_eq!(parse_hand_off("terminal=term_ab12\n").unwrap().terminal.as_deref(), Some("term_ab12"));
    assert_eq!(parse_hand_off("pid=812\n").unwrap().pid, Some(812));
    assert_eq!(parse_hand_off("no_folder\n"), Err((RunReason::NoFolder, None)));
    assert_eq!(parse_hand_off("failed=no_model\n"), Err((RunReason::NoModel, Some("no_model".into()))));
    assert_eq!(parse_hand_off("failed=create_500\n"), Err((RunReason::HandOffFailed, Some("create_500".into()))));
    // Anything but a plain code is dropped rather than kept as the run's detail.
    assert_eq!(parse_hand_off("failed=oops: secret text\n"), Err((RunReason::HandOffFailed, None)));
    assert_eq!(parse_hand_off(""), Err((RunReason::HandOffFailed, None)));
}

#[test]
fn checks_read_each_runs_exit_code() {
    let runs = vec![run("a", RunState::Running), run("b", RunState::Running), run("c", RunState::Running), run("d", RunState::Running)];
    let script = check_script(&runs);
    assert!(script.contains("kill -0 4242"));
    let found = parse_checks("a running\nb exit=0\nc exit=2\nd gone\n", runs);
    let outcomes: Vec<Checked> = found.into_iter().map(|(_, outcome)| outcome).collect();
    assert_eq!(outcomes, vec![Checked::Running, Checked::Exited(0), Checked::Exited(2), Checked::Gone]);
}

#[test]
fn a_failed_agent_keeps_its_exit_code() {
    let running = || run("a", RunState::Running);
    assert_eq!(after_check(running(), Checked::Running, 9_000), None);
    let done = after_check(running(), Checked::Exited(0), 9_000).unwrap();
    assert_eq!((done.state, done.reason, done.detail, done.ended_at_ms), (RunState::Exited, None, None, Some(9_000)));
    let failed = after_check(running(), Checked::Exited(127), 9_000).unwrap();
    assert_eq!((failed.state, failed.reason, failed.detail.as_deref()), (RunState::Failed, Some(RunReason::AgentFailed), Some("127")));
    let gone = after_check(running(), Checked::Gone, 9_000).unwrap();
    assert_eq!(gone.detail.as_deref(), Some("gone"));
}

#[test]
fn runs_round_trip_through_usage_db() {
    let connection = schema::test_database();
    let mut first = run("first", RunState::Running);
    write_run(&connection, &first).unwrap();
    let mut second = run("second", RunState::Queued);
    second.queued_at_ms = 5_000;
    second.handle = RunHandle::default();
    second.reason = Some(RunReason::NoRoom);
    write_run(&connection, &second).unwrap();
    first.state = RunState::Exited;
    first.ended_at_ms = Some(9_000);
    write_run(&connection, &first).unwrap();
    let read = read_runs(&connection, "").unwrap();
    assert_eq!(read, vec![second.clone(), first]);
    assert_eq!(read_runs(&connection, "WHERE state IN ('queued')").unwrap(), vec![second]);
}

/// SECRET: the prompt reaches the machine only inside the script, and nothing Arbor keeps or shows
/// of a run holds it or T3 Code's token.
#[test]
fn secret_the_prompt_and_token_stay_out_of_records_and_scripts_print_only_ids() {
    let connection = schema::test_database();
    let mut asked = request(Harness::T3, "codex");
    asked.title = Some("Nightly".into());
    let mut kept = run("secret", RunState::Failed);
    kept.title = title_of(&asked);
    kept.detail = parse_hand_off(&format!("failed=Bearer {TOKEN} {PROMPT}\n")).err().and_then(|(_, detail)| detail);
    write_run(&connection, &kept).unwrap();
    let stored: String = connection
        .query_row("SELECT group_concat(id || title || folder || ifnull(detail, '') || handle) FROM usage_runs", [], |row| row.get(0))
        .unwrap();
    assert!(!stored.contains("flaky") && !stored.contains(TOKEN), "{stored}");
    assert!(!serde_json::to_string(&kept).unwrap().contains("flaky"));

    let t3 = handoff::t3_script(&asked, "Nightly");
    // The prompt goes into a body file, never onto a command line or into what the script prints.
    assert!(t3.contains("Fix the flaky test"));
    for line in t3.lines().filter(|line| line.contains("printf") || line.contains("curl")) {
        assert!(!line.contains("flaky"), "{line}");
    }
    // The token is only ever read into a variable and written to curl's config file, then cleared.
    assert!(t3.contains("--json > \"$work/session\" 2>/dev/null"));
    assert!(t3.contains("> \"$work/auth\""));
    assert!(t3.contains("issued=\n"));
    assert!(t3.contains("umask 077"));
    assert!(t3.contains("auth session revoke \"$session\""));
    let printed: Vec<&str> = t3.lines().filter(|line| line.trim_start().starts_with("printf '")).collect();
    assert!(printed.iter().all(|line| line.contains("failed=") || line.contains("no_folder") || line.contains("project_id=") || line.contains("header =")), "{printed:?}");

    let orca = handoff::orca_script("id", &request(Harness::Orca, "claude"), "Nightly");
    assert!(orca.contains("2>/dev/null)"));
    let printed: Vec<&str> = orca.lines().filter(|line| line.trim_start().starts_with("printf '")).collect();
    assert!(printed.iter().all(|line| line.contains("failed=") || line.contains("no_folder") || line.contains("terminal=")), "{printed:?}");
}

#[test]
fn the_command_line_runs_detached_with_its_output_kept_on_the_machine() {
    let mut asked = request(Harness::Headless, "claude");
    asked.model = Some("opus".into());
    assert_eq!(headless_command(AgentKind::Claude, &asked, "sess-1"), format!("claude -p --session-id 'sess-1' --model 'opus' {}", shell_quote(PROMPT)));
    let script = headless_script("run-1", AgentKind::Claude, &asked, "sess-1");
    assert!(script.contains("$runs\"/'run-1'.exit"));
    assert!(script.contains("$runs\"/'run-1'.log"));
    // The log is the only thing made private, and nothing the agent prints reaches what Arbor reads.
    assert!(script.contains("(umask 077; : > \"$log_file\")"));
    assert!(!script.lines().any(|line| line.trim() == "umask 077"));
    let printed: Vec<&str> = script.lines().filter(|line| line.trim_start().starts_with("printf '")).collect();
    assert!(printed.iter().all(|line| line.contains("no_folder") || line.contains("pid=")), "{printed:?}");
    assert_eq!(log_path("run-1"), "~/.arbor/runs/run-1.log");
    assert!(headless_command(AgentKind::Codex, &request(Harness::Headless, "codex"), "").starts_with("codex exec '"));
}

/// The scripts parse and run under sh and dash against a stand-in `t3`, `curl` and `orca`, and
/// print only ids. No network, no real harness.
#[test]
fn hand_off_scripts_run_against_stand_ins() {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let home = std::env::temp_dir().join(format!("arbor-runs-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    // The scripts resolve the folder, and macOS's temp dir is behind a link.
    let home = std::fs::canonicalize(&home).unwrap();
    let home = home.as_path();
    // First on the scripts' PATH, so nothing real is ever reached.
    let bin = home.join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(home.join("src/app/.git")).unwrap();
    std::fs::create_dir_all(home.join(".t3/userdata")).unwrap();
    std::fs::write(home.join(".t3/userdata/server-runtime.json"), r#"{"version":1,"pid":1,"port":3773,"origin":"http://127.0.0.1:3773"}"#).unwrap();
    let log = home.join("calls.log");
    let script = |name: &str, body: String| {
        let path = bin.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    };
    let log_line = format!("printf '%s\\n' \"$0 $*\" >> {}\n", log.display());
    script(
        "t3",
        format!(
            "{log_line}case \"$1 $2 $3\" in 'auth session issue') printf '{{\"sessionId\":\"s-1\",\"token\":\"{TOKEN}\"}}\\n' ;; esac\n"
        ),
    );
    // Answers the snapshot with the project, records each body it's sent, and says 200.
    script(
        "curl",
        format!(
            "{log_line}out=; body=\nwhile [ $# -gt 0 ]; do case \"$1\" in -o) out=$2; shift ;; --data-binary) body=${{2#@}}; shift ;; esac; shift; done\nif [ -n \"$body\" ]; then cat \"$body\" >> {bodies}; printf '{{\"sequence\":1}}' > \"$out\"; else printf '{{\"projects\":[{{\"id\":\"p-1\",\"workspaceRoot\":\"%s\",\"deletedAt\":null,\"defaultModelSelection\":{{\"instanceId\":\"codex\",\"model\":\"gpt-test\"}}}}]}}' \"$HOME/src/app\" > \"$out\"; fi\nprintf 200\n",
            bodies = home.join("bodies.log").display()
        ),
    );
    // `git -C <root> worktree add -q -b <name> <path> <base>` makes the folder; anything else is asked for the top.
    script(
        "git",
        format!("case \"$3 $4\" in 'worktree add') {log_line}mkdir -p \"$8\" ;; 'symbolic-ref -q') printf 'origin/main\\n' ;; *) printf '%s\\n' \"$HOME/src/app\" ;; esac\n"),
    );
    script(
        "orca",
        format!(
            "{log_line}case \"$1 $2\" in 'terminal create') printf '{{\"ok\":true,\"result\":{{\"terminal\":{{\"handle\":\"term_ab12\"}}}}}}\\n' ;; 'worktree create') printf '{{\"ok\":true,\"result\":{{\"startupTerminal\":{{\"handle\":\"term_shell\"}},\"agentTerminalHandle\":\"term_wt99\"}}}}\\n' ;; esac\n"
        ),
    );
    // The agents themselves never run for real.
    script("claude", "exit 0\n".into());
    script("codex", "exit 0\n".into());
    let has_reader = ["osascript", "python3", "node"].iter().any(|reader| std::process::Command::new("sh").args(["-c", &format!("command -v {reader}")]).output().is_ok_and(|out| out.status.success()));
    for shell in ["sh", "dash"] {
        if std::process::Command::new(shell).arg("-c").arg("true").output().is_err() {
            continue;
        }
        let _ = std::fs::remove_file(&log);
        let _ = std::fs::remove_file(home.join("bodies.log"));
        let run_script = |text: &str| {
            let output = std::process::Command::new(shell)
                .arg("-s")
                .env("HOME", home)
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .env("TMPDIR", home)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .and_then(|mut child| {
                    use std::io::Write;
                    child.stdin.take().unwrap().write_all(text.as_bytes())?;
                    child.wait_with_output()
                })
                .unwrap();
            (String::from_utf8_lossy(&output.stdout).into_owned(), String::from_utf8_lossy(&output.stderr).into_owned())
        };

        if has_reader {
            let (stdout, stderr) = run_script(&handoff::t3_script(&request(Harness::T3, "codex"), "Nightly"));
            let handle = parse_hand_off(&stdout).unwrap_or_else(|error| panic!("{shell}: {error:?} {stdout} {stderr}"));
            assert_eq!(handle.project_id.as_deref(), Some("p-1"));
            assert!(handle.thread_id.is_some());
            assert!(!stdout.contains(TOKEN) && !stdout.contains("flaky"), "{stdout}");
            let calls = std::fs::read_to_string(&log).unwrap();
            assert!(calls.contains("auth session revoke s-1"), "{calls}");
            assert!(!calls.contains(TOKEN) && !calls.contains("flaky"), "{calls}");
            let bodies = std::fs::read_to_string(home.join("bodies.log")).unwrap();
            assert!(bodies.contains("\"projectId\":\"p-1\"") && bodies.contains("\"model\":\"gpt-test\""), "{bodies}");
            assert!(bodies.contains(PROMPT.replace('"', "\\\"").as_str()), "{bodies}");
            // Nothing is left behind in the temp folder.
            assert!(std::fs::read_dir(home).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().starts_with("arbor-run.")));
        }

        let (stdout, stderr) = run_script(&handoff::orca_script("id", &request(Harness::Orca, "claude"), "Nightly"));
        assert_eq!(parse_hand_off(&stdout).map(|handle| handle.terminal), Ok(Some("term_ab12".into())), "{shell}: {stderr}");
        let calls = std::fs::read_to_string(&log).unwrap();
        assert!(calls.contains("repo add --path"), "{calls}");

        // In its own worktree, Orca makes it and starts the agent there; the handle is the agent's terminal.
        let mut own = request(Harness::Orca, "claude");
        own.worktree = true;
        let (stdout, stderr) = run_script(&handoff::orca_script("5e1f0a2b-77aa-4c1d-8e2f-000000000001", &own, "Nightly"));
        assert_eq!(parse_hand_off(&stdout).map(|handle| handle.terminal), Ok(Some("term_wt99".into())), "{shell}: {stderr}");
        let calls = std::fs::read_to_string(&log).unwrap();
        assert!(calls.contains("worktree create --repo path:") && calls.contains("--name arbor-5e1f0a2b --agent claude"), "{calls}");

        // On the command line, a new worktree on a branch of its own off the default branch, under ~/.arbor/worktrees.
        let mut headless = request(Harness::Headless, "claude");
        headless.worktree = true;
        let (stdout, stderr) = run_script(&headless_script("5e1f0a2b-77aa-4c1d-8e2f-000000000002", AgentKind::Claude, &headless, "s"));
        assert!(stdout.contains("pid="), "{shell}: {stdout} {stderr}");
        assert!(home.join(".arbor/worktrees/arbor-5e1f0a2b").is_dir());
        let calls = std::fs::read_to_string(&log).unwrap();
        assert!(calls.contains("worktree add -q -b arbor-5e1f0a2b") && calls.contains("origin/main"), "{calls}");
        let _ = std::fs::remove_dir_all(home.join(".arbor/worktrees"));

        let mut missing = request(Harness::Orca, "claude");
        missing.folder = "~/nowhere".into();
        assert_eq!(parse_hand_off(&run_script(&handoff::orca_script("id", &missing, "x")).0), Err((RunReason::NoFolder, None)));

        // The command line: what the agent prints lands in its private log, the exit code beside it, a week-old log
        // goes, and the agent's own files keep the usual permissions.
        use std::os::unix::fs::PermissionsExt;
        script("claude", "printf 'API Error: 401\\n' >&2; : > made-by-agent; exit 3\n".into());
        let runs = home.join(".arbor/runs");
        std::fs::create_dir_all(&runs).unwrap();
        let old_log = runs.join("old.log");
        std::fs::write(&old_log, "old").unwrap();
        assert!(std::process::Command::new("touch").args(["-t", "202001010000"]).arg(&old_log).status().unwrap().success());
        let id = format!("cli-{shell}");
        let (stdout, stderr) = run_script(&format!("umask 022\n{}", headless_script(&id, AgentKind::Claude, &request(Harness::Headless, "claude"), "sess-1")));
        assert!(parse_hand_off(&stdout).is_ok_and(|handle| handle.pid.is_some()), "{shell}: {stdout} {stderr}");
        let exit = runs.join(format!("{id}.exit"));
        for _ in 0..100 {
            if std::fs::read_to_string(&exit).is_ok_and(|code| code.ends_with('\n')) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(std::fs::read_to_string(&exit).unwrap().trim(), "3", "{shell}");
        let log_file = runs.join(format!("{id}.log"));
        assert_eq!(std::fs::read_to_string(&log_file).unwrap(), "API Error: 401\n", "{shell}");
        assert_eq!(std::fs::metadata(&log_file).unwrap().permissions().mode() & 0o777, 0o600, "{shell}");
        assert!(!old_log.exists(), "{shell}");
        assert_eq!(std::fs::metadata(home.join("src/app/made-by-agent")).unwrap().permissions().mode() & 0o777, 0o644, "{shell}");
    }
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn a_slot_counts_on_its_machine_until_it_lapses_or_is_let_go() {
    let mut slots = Reservations::default();
    let first = slots.take("Cedar-02", 1_000);
    slots.take("cedar-02", 2_000);
    slots.take("ci-01", 2_000);
    assert_eq!(slots.counts(500), BTreeMap::from([(normalize_machine_name("cedar-02"), 2), (normalize_machine_name("ci-01"), 1)]));
    // The first lapses; one let go stops counting at once.
    assert_eq!(slots.counts(1_000), BTreeMap::from([(normalize_machine_name("cedar-02"), 1), (normalize_machine_name("ci-01"), 1)]));
    slots.release(first);
    let ci = slots.held.iter().find(|slot| slot.machine == normalize_machine_name("ci-01")).map(|slot| slot.id).unwrap_or_default();
    slots.release(ci);
    assert_eq!(slots.counts(1_500), BTreeMap::from([(normalize_machine_name("cedar-02"), 1)]));
}

#[test]
fn a_started_run_holds_its_slot_until_the_board_shows_its_id() {
    let mut slots = Reservations::default();
    let run = slots.take("cedar-02", 1_000);
    let other = slots.take("cedar-02", 1_000);
    slots.started(run, vec!["thread-1".into()], 9_000);
    // Its hold runs from the hand-off now, not the pick.
    assert_eq!(slots.counts(2_000), BTreeMap::from([(normalize_machine_name("cedar-02"), 1)]));
    assert!(!slots.seen(&BTreeSet::from(["thread-2".to_string()])));
    assert!(slots.seen(&BTreeSet::from(["thread-1".to_string()])));
    assert!(slots.counts(2_000).is_empty());
    // A slot with no ids is never let go by the board, only by lapsing.
    assert!(!slots.seen(&BTreeSet::from([String::new()])));
    // The other was never handed off, and lapsed with its pick.
    assert!(slots.held.iter().all(|slot| slot.id != other));
}
