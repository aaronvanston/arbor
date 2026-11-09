//! What a shell command runs, read from its text. This is a reading, not a shell: it splits on pipes and separators
//! outside quotes and takes each part's first word, which is right for the commands agents write and close enough
//! for the odd one that isn't.

/// Words that come before the program they run.
const WRAPPERS: [&str; 14] = ["sudo", "time", "env", "nohup", "command", "exec", "nice", "then", "do", "else", "elif", "if", "while", "until"];
/// Words that open or close a block and run nothing themselves.
const KEYWORDS: [&str; 7] = ["for", "case", "select", "function", "done", "fi", "esac"];
/// Commands that set a shell up for the one that matters: `cd app && cargo test` is about cargo.
const SETUP: [&str; 8] = ["cd", "export", "set", "source", ".", "pushd", "popd", "unset"];
const SCRIPT_RUNNERS: [(&str, &str); 9] = [
    ("python", "python"),
    ("python3", "python"),
    ("node", "javascript"),
    ("bun", "javascript"),
    ("deno", "javascript"),
    ("ruby", "ruby"),
    ("perl", "perl"),
    ("php", "php"),
    ("osascript", "applescript"),
];

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Shell {
    /// The first program that isn't setting the shell up, or the first of all when that's all there is.
    pub(crate) program: Option<String>,
    pub(crate) programs: Vec<String>,
    pub(crate) pipes_to_head_tail: bool,
    pub(crate) uses_grep: bool,
    pub(crate) uses_rg: bool,
    pub(crate) inline_script: bool,
    pub(crate) script_language: Option<String>,
}

struct Part {
    words: Vec<String>,
    piped_into: bool,
    heredoc: bool,
}

/// The command without its here-documents' bodies, which are a script's text and not commands, and whether each
/// line opened one.
fn without_heredocs(command: &str) -> Vec<(String, bool)> {
    let mut lines = Vec::new();
    let mut until: Option<String> = None;
    for line in command.lines() {
        if let Some(end) = &until {
            if line.trim() == end {
                until = None;
            }
            continue;
        }
        let opened = line.find("<<").filter(|at| !line[at + 2..].starts_with('<')).and_then(|at| {
            let word: String = line[at + 2..].trim_start_matches(['-', '~']).trim_start().chars().take_while(|c| !c.is_whitespace() && !";|&)".contains(*c)).collect();
            let word = word.trim_matches(['\'', '"', '\\']).to_string();
            (!word.is_empty()).then_some(word)
        });
        lines.push((line.to_string(), opened.is_some()));
        until = opened;
    }
    lines
}

fn parts(command: &str) -> Vec<Part> {
    let mut parts = Vec::new();
    let mut piped_into = false;
    for (line, heredoc) in without_heredocs(command) {
        let mut words: Vec<String> = Vec::new();
        let mut word = String::new();
        let mut quote: Option<char> = None;
        let mut chars = line.chars().peekable();
        let mut end_part = |words: &mut Vec<String>, word: &mut String, piped: &mut bool, next_piped: bool| {
            if !word.is_empty() {
                words.push(std::mem::take(word));
            }
            if !words.is_empty() {
                parts.push(Part { words: std::mem::take(words), piped_into: *piped, heredoc });
            }
            *piped = next_piped;
        };
        while let Some(c) = chars.next() {
            match (quote, c) {
                (Some(q), _) if c == q => quote = None,
                (Some('"'), '\\') | (None, '\\') => word.extend(chars.next()),
                (Some(_), _) => word.push(c),
                (None, '\'' | '"') => quote = Some(c),
                (None, '#') if word.is_empty() => break,
                (None, '|') => {
                    let or = chars.next_if_eq(&'|').is_some();
                    chars.next_if_eq(&'&');
                    end_part(&mut words, &mut word, &mut piped_into, !or);
                }
                // `2>&1` and `&>out` send output somewhere; they don't end a command.
                (None, '&') if word.ends_with('>') || chars.peek() == Some(&'>') => word.push(c),
                (None, '&') => {
                    chars.next_if_eq(&'&');
                    end_part(&mut words, &mut word, &mut piped_into, false);
                }
                (None, ';') => end_part(&mut words, &mut word, &mut piped_into, false),
                (None, c) if c.is_whitespace() => {
                    if !word.is_empty() {
                        words.push(std::mem::take(&mut word));
                    }
                }
                (None, _) => word.push(c),
            }
        }
        end_part(&mut words, &mut word, &mut piped_into, false);
    }
    parts
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

/// The program a part runs and the words after it.
fn program(words: &[String]) -> Option<(String, &[String])> {
    let mut rest = words;
    loop {
        let (first, after) = rest.split_first()?;
        let bare = first.trim_start_matches(['(', '{', '!']);
        let name = bare.rsplit('/').next().unwrap_or(bare).trim_end_matches(')');
        if KEYWORDS.contains(&name) {
            return None;
        } else if name.is_empty() || name == "}" || is_assignment(bare) || WRAPPERS.contains(&name) {
            rest = after;
        } else if name == "timeout" {
            // `timeout 30 cargo test`: the wait, then the program.
            rest = after.split_first().map_or(after, |(_, tail)| tail);
        } else if name == "uv" && after.first().is_some_and(|word| word == "run") {
            rest = &after[1..];
        } else {
            return Some((name.to_string(), after));
        }
    }
}

pub(crate) fn read(command: &str) -> Shell {
    let mut shell = Shell::default();
    for part in parts(command) {
        let Some((name, args)) = program(&part.words) else {
            continue;
        };
        shell.pipes_to_head_tail |= part.piped_into && matches!(name.as_str(), "head" | "tail");
        shell.uses_grep |= matches!(name.as_str(), "grep" | "egrep" | "fgrep");
        shell.uses_rg |= name == "rg";
        if let Some((_, language)) = SCRIPT_RUNNERS.iter().find(|(runner, _)| *runner == name) {
            let inline = part.heredoc || args.iter().any(|arg| matches!(arg.as_str(), "-c" | "-e" | "--eval" | "-" | "-p" | "--print"));
            if inline && !shell.inline_script {
                shell.inline_script = true;
                shell.script_language = Some((*language).to_string());
            }
        }
        if !shell.programs.contains(&name) {
            shell.programs.push(name);
        }
    }
    shell.program = shell.programs.iter().find(|name| !SETUP.contains(&name.as_str())).or(shell.programs.first()).cloned();
    shell
}

/// A file's extension and the language it's written in, when the extension says.
pub(crate) fn language(path: &str) -> (Option<String>, Option<String>) {
    let name = path.rsplit('/').next().unwrap_or(path);
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return (None, None);
    };
    if stem.is_empty() || ext.is_empty() || ext.len() > 12 {
        return (None, None);
    }
    let ext = ext.to_ascii_lowercase();
    let language = match ext.as_str() {
        "rs" => "Rust",
        "ts" | "tsx" | "mts" | "cts" => "TypeScript",
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "py" | "pyi" => "Python",
        "go" => "Go",
        "rb" => "Ruby",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "swift" => "Swift",
        "c" | "h" => "C",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => "C++",
        "cs" => "C#",
        "php" => "PHP",
        "sh" | "bash" | "zsh" | "fish" => "Shell",
        "sql" => "SQL",
        "html" | "htm" => "HTML",
        "css" | "scss" | "sass" | "less" => "CSS",
        "md" | "mdx" => "Markdown",
        "json" | "jsonl" | "jsonc" => "JSON",
        "yaml" | "yml" => "YAML",
        "toml" => "TOML",
        "xml" => "XML",
        "vue" => "Vue",
        "svelte" => "Svelte",
        "lua" => "Lua",
        "ex" | "exs" => "Elixir",
        "dart" => "Dart",
        "scala" => "Scala",
        "zig" => "Zig",
        "tf" => "Terraform",
        _ => return (Some(ext), None),
    };
    (Some(ext), Some(language.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn programs(command: &str) -> Vec<String> {
        read(command).programs
    }

    #[test]
    fn a_pipeline_names_each_program_once_in_order() {
        assert_eq!(programs("cd /srv/app && git status | head -5; git status"), ["cd", "git", "head"]);
        assert_eq!(read("FOO=1 sudo /usr/bin/env cargo test 2>&1 | tail -20").program.as_deref(), Some("cargo"));
        assert_eq!(programs("timeout 30 bun test || echo failed"), ["bun", "echo"]);
        assert_eq!(programs("(cd src && ls)"), ["cd", "ls"]);
        assert_eq!(read("cd /srv/app && export CI=1 && bun test").program.as_deref(), Some("bun"));
        assert_eq!(read("cd /srv/app").program.as_deref(), Some("cd"));
        assert_eq!(programs("for f in a b; do wc -l $f; done; until curl -sf localhost; do sleep 1; done"), ["wc", "curl", "sleep"]);
        assert_eq!(programs("if grep -q x f; then echo yes; else echo no; fi"), ["grep", "echo"]);
    }

    #[test]
    fn head_and_tail_count_only_at_the_end_of_a_pipe() {
        assert!(read("cargo test 2>&1 | tail -20").pipes_to_head_tail);
        assert!(!read("tail -f app.log").pipes_to_head_tail);
        assert!(!read("ls || head x").pipes_to_head_tail);
        assert_eq!(programs("make &> build.log & cargo test 2>&1 | tail -5"), ["make", "cargo", "tail"]);
    }

    #[test]
    fn quoted_separators_and_comments_are_not_commands() {
        assert_eq!(programs("echo 'a | grep b; rm -rf x' # | rg nothing"), ["echo"]);
        assert_eq!(programs("git commit -m \"fix: a && b\""), ["git"]);
        let shell = read("grep -rn foo src | rg bar");
        assert!(shell.uses_grep && shell.uses_rg);
    }

    #[test]
    fn a_script_handed_to_an_interpreter_is_inline_and_its_body_is_not_read_as_commands() {
        let shell = read("python3 - <<'PY'\nimport os; print(os.getcwd())\nrm = 1 | 2\nPY\necho done");
        assert_eq!(shell.programs, ["python3", "echo"]);
        assert!(shell.inline_script);
        assert_eq!(shell.script_language.as_deref(), Some("python"));
        assert_eq!(read("node -e 'console.log(1)'").script_language.as_deref(), Some("javascript"));
        assert_eq!(read("uv run python -c 'print(1)'").program.as_deref(), Some("python"));
        assert!(!read("python3 scripts/build.py").inline_script);
        assert!(!read("cat <<EOF > notes.txt\nhello\nEOF").inline_script);
    }

    #[test]
    fn a_path_gives_its_extension_and_language() {
        assert_eq!(language("/srv/app/src/main.rs"), (Some("rs".into()), Some("Rust".into())));
        assert_eq!(language("notes.TXT"), (Some("txt".into()), None));
        assert_eq!(language("/srv/app/Makefile"), (None, None));
        assert_eq!(language("/srv/app/.gitignore"), (None, None));
    }
}
