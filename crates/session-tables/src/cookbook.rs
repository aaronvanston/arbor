//! Questions worth asking of the tables, each as one `SELECT`. They are documentation that runs: a test runs every
//! one against real tables, so a column that is renamed takes its query with it or fails there.

/// A question, by a short name, with the query that answers it.
pub struct Saved {
    pub name: &'static str,
    pub about: &'static str,
    pub sql: &'static str,
}

pub fn saved(name: &str) -> Option<&'static Saved> {
    SAVED.iter().find(|saved| saved.name == name)
}

pub const SAVED: [Saved; 15] = [
    Saved {
        name: "speed-by-model",
        about: "How fast each model writes: median tokens a second and time to the first token, as the proxy saw them",
        sql: "SELECT model, count(*) AS replies, round(median(tokens_per_second), 1) AS tokens_per_second, round(median(ttft_ms)) AS first_token_ms FROM speed GROUP BY model HAVING count(*) >= 20 ORDER BY replies DESC",
    },
    Saved {
        name: "requests-per-prompt",
        about: "How many model requests and tool calls one prompt leads to, by agent and model",
        sql: "SELECT agent, model, count(*) AS sessions, round(sum(requests) * 1.0 / sum(prompts), 1) AS requests_per_prompt, round(sum(tool_calls) * 1.0 / sum(prompts), 1) AS tool_calls_per_prompt FROM sessions WHERE prompts > 0 AND model IS NOT NULL GROUP BY agent, model HAVING count(*) >= 5 ORDER BY sessions DESC",
    },
    Saved {
        name: "thinking-share",
        about: "The share of each model's output tokens that went on thinking",
        sql: "SELECT agent, model, count(*) AS requests, round(100.0 * sum(thinking) / nullif(sum(output), 0), 1) AS thinking_pct FROM requests WHERE thinking IS NOT NULL GROUP BY agent, model HAVING count(*) >= 20 ORDER BY requests DESC",
    },
    Saved {
        name: "parallel-tool-calls",
        about: "How often a Claude Code reply calls more than one tool at once, by model",
        sql: "SELECT model, count(*) AS replies_with_tools, round(100.0 * count(*) FILTER (WHERE calls > 1) / count(*), 1) AS parallel_pct, round(avg(calls), 2) AS calls_per_reply FROM (SELECT r.model, c.message_id, count(*) AS calls FROM tool_calls c JOIN (SELECT message_id, any_value(model) AS model FROM requests WHERE agent = 'claude' AND message_id IS NOT NULL GROUP BY message_id) r USING (message_id) WHERE c.agent = 'claude' GROUP BY r.model, c.message_id) GROUP BY model ORDER BY replies_with_tools DESC",
    },
    Saved {
        name: "shell-habits",
        about: "How each agent uses the shell: grep or rg, piping into head or tail, inline scripts, and how long its commands are",
        sql: "SELECT agent, count(*) AS commands, round(100.0 * count(*) FILTER (WHERE uses_grep) / count(*), 1) AS grep_pct, round(100.0 * count(*) FILTER (WHERE uses_rg) / count(*), 1) AS rg_pct, round(100.0 * count(*) FILTER (WHERE pipes_to_head_tail) / count(*), 1) AS head_tail_pct, round(100.0 * count(*) FILTER (WHERE inline_script) / count(*), 1) AS inline_script_pct, round(avg(command_chars)) AS mean_chars FROM commands GROUP BY agent ORDER BY commands DESC",
    },
    Saved {
        name: "inline-scripts",
        about: "Scripts written straight into a shell command instead of a file, by language",
        sql: "SELECT agent, script_language, count(*) AS runs, round(avg(command_chars)) AS mean_chars FROM commands WHERE inline_script GROUP BY agent, script_language ORDER BY runs DESC",
    },
    Saved {
        name: "programs",
        about: "The programs agents run most, and how often each fails",
        sql: "SELECT program, count(*) AS runs, round(100.0 * count(*) FILTER (WHERE exit_code <> 0) / nullif(count(exit_code), 0), 1) AS failed_pct FROM commands WHERE program IS NOT NULL GROUP BY program ORDER BY runs DESC LIMIT 40",
    },
    Saved {
        name: "tool-errors",
        about: "Each tool's calls, error rate and median time from call to result",
        sql: "SELECT agent, tool, count(*) AS calls, round(100.0 * count(*) FILTER (WHERE is_error) / nullif(count(is_error), 0), 1) AS error_pct, round(median(elapsed_ms)) AS median_ms FROM tools GROUP BY agent, tool HAVING count(*) >= 20 ORDER BY calls DESC",
    },
    Saved {
        name: "cache-hits",
        about: "The share of each model's input that was read from the cache",
        sql: "SELECT agent, model, count(*) AS requests, round(100.0 * sum(cache_read) / nullif(sum(input + cache_read + cache_write), 0), 1) AS cache_read_pct FROM requests WHERE model IS NOT NULL GROUP BY agent, model HAVING count(*) >= 20 ORDER BY requests DESC",
    },
    Saved {
        name: "hook-time",
        about: "Where hooks spend time: runs, total seconds and failures for each",
        sql: "SELECT name, event, count(*) AS runs, round(sum(duration_ms) / 1000.0) AS seconds, round(median(duration_ms)) AS median_ms, count(*) FILTER (WHERE exit_code <> 0) AS failed FROM hooks GROUP BY name, event ORDER BY seconds DESC NULLS LAST",
    },
    Saved {
        name: "cost-by-day",
        about: "Requests, output tokens and cost for each of the last 30 days, as the proxy saw them",
        sql: "SELECT day, count(*) AS requests, CAST(sum(output) AS BIGINT) AS output, round(sum(cost), 2) AS cost FROM proxy_requests WHERE day >= current_date - 30 GROUP BY day ORDER BY day",
    },
    Saved {
        name: "cost-by-model",
        about: "Each model's requests, cost, failure rate and median latency, as the proxy saw them",
        sql: "SELECT model, count(*) AS requests, round(sum(cost), 2) AS cost, round(100.0 * count(*) FILTER (WHERE failed) / count(*), 1) AS failed_pct, round(median(latency_ms)) AS median_ms FROM proxy_requests GROUP BY model ORDER BY cost DESC NULLS LAST",
    },
    Saved {
        name: "languages",
        about: "The languages of the files agents read and change",
        sql: "SELECT language, count(*) AS touches, count(*) FILTER (WHERE op IN ('edit', 'write', 'add')) AS changes, CAST(sum(lines_added) AS BIGINT) AS added, CAST(sum(lines_removed) AS BIGINT) AS removed FROM files_touched WHERE language IS NOT NULL GROUP BY language ORDER BY touches DESC LIMIT 30",
    },
    Saved {
        name: "biggest-sessions",
        about: "The 25 sessions that wrote the most output, with their requests, tool calls and cost",
        sql: "SELECT agent, session_id, day, model, requests, tool_calls, tool_errors, output, round(cost, 2) AS cost FROM sessions ORDER BY output DESC LIMIT 25",
    },
    Saved {
        name: "pull-requests",
        about: "Sessions, requests, tool calls and cost behind each pull request Claude Code linked (needs the Everything detail)",
        sql: "WITH links AS (SELECT DISTINCT session_id, json_extract_string(rest, '$.prRepository') AS repository, TRY_CAST(json_extract_string(rest, '$.prNumber') AS BIGINT) AS number FROM lines WHERE kind = 'pr-link') SELECT repository, number, count(*) AS sessions, CAST(sum(s.requests) AS BIGINT) AS requests, CAST(sum(s.tool_calls) AS BIGINT) AS tool_calls, CAST(sum(s.output) AS BIGINT) AS output, round(sum(s.cost), 2) AS cost FROM links JOIN sessions s USING (session_id) WHERE repository IS NOT NULL GROUP BY repository, number ORDER BY cost DESC NULLS LAST LIMIT 50",
    },
];
