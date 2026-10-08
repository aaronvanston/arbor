//! The types the webview's commands take and return, written out as TypeScript in
//! `src/native/types.ts` so the two sides are one definition. `src/native/` lists each
//! command with its types, and `tests/commandParity.test.ts` checks that list against
//! the signatures here. The test below fails when the file is out of date;
//! `bun run bindings` rewrites it.
//!
//! A type a command takes or returns gets `#[derive(TS)]` beside its serde derives and
//! goes in `command_types`; the types inside it come along on their own.

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::Path;

    use ts_rs::{Config, TypeVisitor, TS};

    const OUTPUT: &str = "../src/native/types.ts";

    const HEADER: &str = "// Written by `bun run bindings` from the Rust types in src-tauri (see src-tauri/src/bindings.rs).\n\
// Don't edit it by hand: `bun run verify:rust` fails when it no longer matches them.\n";

    /// The types commands take and return, by domain as in `src/native/`.
    fn command_types(types: &mut Collected) {
        types.visit::<crate::command_error::CommandError>();
        // App
        types.visit::<crate::GuiSettings>();
        types.visit::<crate::SoftwareSettings>();
        types.visit::<crate::SoftwareSettingsInput>();
        types.visit::<crate::system_locale::SystemLocale>();
        types.visit::<crate::tray::TraySection>();
        types.visit::<crate::tray::TrayRow>();
        types.visit::<crate::phone_alerts::PhoneAlertSecretStatus>();
        types.visit::<crate::phone_alerts::PhoneAlertSecret>();
        types.visit::<crate::phone_alerts::PhoneAlertRoute>();
        types.visit::<crate::phone_alerts::PhoneAlert>();
        types.visit::<crate::AppUpdateInfo>();
        types.visit::<crate::AppUpdateTask>();
        types.visit::<crate::release_feed::UpdateChannel>();
        types.visit::<crate::dev_builds::DevBuildStatus>();
        types.visit::<crate::zoom::ZoomLevel>();
        types.visit::<crate::app_menu::AppMenuAction>();
        types.visit::<crate::app_icon::AppIconSetting>();
        types.visit::<crate::product_analytics::ProductAnalyticsSettings>();
        types.visit::<crate::product_analytics::ProductAnalyticsInput>();
        types.visit::<crate::product_analytics::ProductEvent>();
        types.visit::<crate::product_analytics::Feature>();
        types.visit::<crate::product_analytics::ExceptionReport>();
        // Command line
        types.visit::<crate::saved_store::SavedStoreSnapshot>();
        types.visit::<crate::saved_store::SavedStoreChange>();
        types.visit::<crate::cli::bridge::CliWindowAction>();
        types.visit::<crate::cli::bridge::CliWindowError>();
        types.visit::<crate::cli::settings::CliOverview>();
        types.visit::<crate::cli::settings::CliSettings>();
        types.visit::<crate::cli::settings::CliInstallResult>();
        types.visit::<crate::usage::machine_health::cli_skill::CliSkillInstall>();
        types.visit::<crate::usage::machine_health::cli_skill::CliSkillState>();
        // Core
        types.visit::<crate::CoreStatus>();
        types.visit::<crate::CoreLatest>();
        types.visit::<crate::CoreInstallTask>();
        types.visit::<crate::CoreInstallResult>();
        types.visit::<crate::CoreConfigView>();
        types.visit::<crate::CoreTlsSettings>();
        types.visit::<crate::CoreLoggingSettingsInput>();
        types.visit::<crate::proxy_checks::ProxyChecks>();
        types.visit::<crate::settings_in_effect::SettingsInEffect>();
        types.visit::<crate::GuiNetworkEndpointSettings>();
        types.visit::<crate::GuiRetrySettings>();
        types.visit::<crate::GuiSessionRoutingSettings>();
        types.visit::<crate::ModelOverrideEntry>();
        types.visit::<crate::ExtraModelsView>();
        types.visit::<crate::ExtraModelsProvider>();
        types.visit::<crate::ExtraModel>();
        types.visit::<crate::SpeedAliasEntry>();
        types.visit::<crate::ThinkingAliasEntry>();
        types.visit::<crate::ThinkingAliasSource>();
        types.visit::<crate::management_api::OAuthStatusResult>();
        types.visit::<crate::management_api::OAuthStartResult>();
        types.visit::<crate::management_api::ManagementRequest>();
        types.visit::<crate::auth_file_contents::ReauthFold>();
        types.visit::<crate::auth_file_contents::AuthFileExcludedModels>();
        types.visit::<crate::oauth_browser::OAuthBrowserOption>();
        // Usage
        types.visit::<crate::usage::UsageQuery>();
        types.visit::<crate::usage::UsageCollectorStatus>();
        types.visit::<crate::usage::UsageOverview>();
        types.visit::<crate::usage::UsageAnalysis>();
        types.visit::<crate::usage::UsageEventPage>();
        types.visit::<crate::usage::UsagePricing>();
        types.visit::<crate::usage::ModelPrice>();
        types.visit::<crate::usage::ModelPriceSyncResult>();
        types.visit::<crate::usage::UsageSessionPage>();
        types.visit::<crate::usage::HeavySessionCandidate>();
        types.visit::<crate::usage::UsageSessionTimeline>();
        types.visit::<crate::usage::UsageRepairResult>();
        types.visit::<crate::usage::storage::UsageStorageInfo>();
        types.visit::<crate::usage::storage::UsageRetentionResult>();
        types.visit::<crate::usage::storage::UsageCompactionResult>();
        types.visit::<crate::usage::digest::CacheMisses>();
        types.visit::<crate::usage::capacity::CapacityQuery>();
        types.visit::<crate::usage::capacity::CapacityReport>();
        types.visit::<crate::usage::capacity::LimitCycle>();
        types.visit::<crate::usage::limit_history::LimitReading>();
        types.visit::<crate::usage::limit_history::LimitAccountRename>();
        types.visit::<crate::usage::fleet::FleetSources>();
        types.visit::<crate::usage::fleet::FleetTrayCounts>();
        types.visit::<crate::usage::antiburn::AntiburnStatus>();
        types.visit::<crate::usage::live::LiveSessionsReport>();
        types.visit::<crate::usage::machine_sessions::MachineSessions>();
        types.visit::<crate::usage::machines::MachineAssignment>();
        types.visit::<crate::usage::projects::SessionProjectsReport>();
        types.visit::<crate::usage::projects::MergedPullRequests>();
        types.visit::<crate::usage::pull_requests::NamedPullRequests>();
        types.visit::<crate::usage::machine_health::transcripts::PullRequestLink>();
        // Automations
        types.visit::<crate::usage::machine_health::automations::AutomationList>();
        types.visit::<crate::usage::machine_health::grove::MachineProbes>();
        types.visit::<crate::usage::machine_health::grove::MachineHistory>();
        types.visit::<crate::usage::machine_health::automations::Automation>();
        types.visit::<crate::usage::machine_health::automations::AutomationRun>();
        types.visit::<crate::usage::machine_health::automations::AutomationInput>();
        types.visit::<crate::usage::machine_health::automations::AutomationDraft>();
        types.visit::<crate::usage::machine_health::automations::AutomationDraftInput>();
        // Machines
        types.visit::<crate::usage::machine_health::MachineHost>();
        types.visit::<crate::usage::machine_health::ThisMac>();
        types.visit::<crate::usage::machine_health::host_keys::MachineHostKeyScan>();
        types.visit::<crate::usage::machine_health::MachineHealthSnapshot>();
        types.visit::<crate::usage::machine_health::discovery::DiscoveredHost>();
        types.visit::<crate::usage::machine_health::agent_homes::AgentHome>();
        types.visit::<crate::usage::machine_health::agent_homes::AgentHomesView>();
        types.visit::<crate::usage::machine_health::cleanup::CleanupScan>();
        types.visit::<crate::usage::machine_health::cleanup::CleanupTarget>();
        types.visit::<crate::usage::machine_health::cleanup::SetAsideRef>();
        types.visit::<crate::usage::machine_health::cleanup::CleanupRemoval>();
        types.visit::<crate::usage::machine_health::cleanup::CleanupRestore>();
        types.visit::<crate::usage::machine_health::cleanup::AgentUninstall>();
        types.visit::<crate::usage::machine_health::pools::MachinePool>();
        types.visit::<crate::usage::machine_health::pools::PoolPreview>();
        types.visit::<crate::usage::machine_health::pool_ssh::PoolSsh>();
        types.visit::<crate::usage::machine_health::runs::RunRequest>();
        types.visit::<crate::usage::machine_health::runs::HarnessRun>();
        types.visit::<crate::usage::machine_health::agent_releases::LatestVersions>();
        types.visit::<crate::usage::machine_health::agent_releases::T3Policy>();
        types.visit::<crate::usage::machine_health::agents::AgentKind>();
        types.visit::<crate::usage::machine_health::agents::AgentUpdate>();
        types.visit::<crate::usage::machine_health::harness_update::HarnessUpdate>();
        types.visit::<crate::usage::machine_health::attention::AgentAttentionReport>();
        types.visit::<crate::usage::machine_health::attention::ReporterSetup>();
        types.visit::<crate::usage::machine_health::attention::SettingsEdit>();
        types.visit::<crate::usage::machine_health::client_versions::ClientVersions>();
        types.visit::<crate::usage::machine_health::telemetry::TelemetryStatus>();
        types.visit::<crate::usage::machine_health::telemetry::TelemetrySetup>();
        types.visit::<crate::usage::machine_health::telemetry::TelemetryBreakdown>();
        types.visit::<crate::usage::diagnostics::CallDiagnostics>();
        types.visit::<crate::usage::diagnostics::ClearedCalls>();
        // Setup
        types.visit::<crate::usage::machine_health::setup::SetupInventory>();
        types.visit::<crate::usage::machine_health::setup::SetupText>();
        types.visit::<crate::usage::machine_health::setup::SetupSkillFile>();
        types.visit::<crate::usage::machine_health::setup_sync::SetupRepo>();
        types.visit::<crate::usage::machine_health::project_places::ProjectsDrift>();
        types.visit::<crate::usage::machine_health::setup_standing::SyncStanding>();
        types.visit::<crate::usage::machine_health::setup_repo_keeper::RepoKeeper>();
        types.visit::<crate::usage::machine_health::setup_autoline::AutoLine>();
        types.visit::<crate::usage::machine_health::setup_autoline::AutoLineEvent>();
        types.visit::<crate::usage::machine_health::project_fixes::ProjectFixRequest>();
        types.visit::<crate::usage::machine_health::project_fixes::ProjectFixes>();
        types.visit::<crate::usage::machine_health::project_skills::ProjectSkillsOutcome>();
        types.visit::<crate::usage::machine_health::project_hub::HubSync>();
        types.visit::<crate::usage::machine_health::setup_repo_browse::RepoTree>();
        types.visit::<crate::usage::machine_health::setup_repo_browse::RepoText>();
        types.visit::<crate::usage::machine_health::setup_repo_browse::RepoChange>();
        types.visit::<crate::usage::machine_health::setup_wanted::SkillWanted>();
        types.visit::<crate::usage::machine_health::setup_wanted::PluginWanted>();
        types.visit::<crate::usage::machine_health::setup_sync::SyncChange>();
        types.visit::<crate::usage::machine_health::setup_sync::SetupBackup>();
        types.visit::<crate::usage::machine_health::guarded_writes::SyncOutcome>();
        types.visit::<crate::usage::machine_health::setup_repo_skills::SourceCheck>();
        types.visit::<crate::usage::machine_health::plugin_catalog::MarketplaceCatalog>();
        types.visit::<crate::usage::machine_health::setup_skills::SkillChange>();
        types.visit::<crate::usage::machine_health::transcripts::SkillUsageReport>();
        types.visit::<crate::usage::machine_health::setup_plugins::PluginChange>();
        types.visit::<crate::usage::machine_health::setup_plugins::CodexPluginChange>();
        types.visit::<crate::usage::machine_health::setup_plugins::PluginResult>();
        types.visit::<crate::usage::machine_health::checkout_settings::CheckoutSkillChange>();
        types.visit::<crate::usage::machine_health::checkout_settings::CheckoutSkillResult>();
        types.visit::<crate::usage::machine_health::checkout_settings::CheckoutMcpChange>();
        types.visit::<crate::usage::machine_health::checkout_settings::CheckoutMcpResult>();
        types.visit::<crate::usage::machine_health::project_instructions::CheckoutInstructionsChange>();
        types.visit::<crate::usage::machine_health::project_instructions::CheckoutInstructionsResult>();
        types.visit::<crate::usage::machine_health::setup_plugins::McpHealth>();
        types.visit::<crate::usage::machine_health::setup_plugins::PluginCosts>();
        types.visit::<crate::usage::machine_health::transcripts::McpUsageReport>();
        types.visit::<crate::usage::machine_health::setup_mcp::McpRegistry>();
        types.visit::<crate::usage::machine_health::setup_mcp::McpWanted>();
        types.visit::<crate::usage::machine_health::setup_hooks::HookRegistry>();
        types.visit::<crate::usage::machine_health::setup_hooks::HookWanted>();
        types.visit::<crate::usage::machine_health::setup_plugins::PluginLeftover>();
        types.visit::<crate::usage::machine_health::setup_mcp::McpChange>();
        types.visit::<crate::usage::machine_health::setup_mcp::McpResult>();
        types.visit::<crate::usage::machine_health::setup_projects::MachineProjects>();
        types.visit::<crate::usage::machine_health::setup_projects::WorktreeRemoval>();
        types.visit::<crate::usage::machine_health::setup_projects::RemovalResult>();
        types.visit::<crate::usage::machine_health::setup_toolchain::MachineToolchain>();
        types.visit::<crate::usage::machine_health::setup_toolchain::NodeChange>();
        types.visit::<crate::usage::machine_health::setup_toolchain::NodeResult>();
        types.visit::<crate::usage::machine_health::starting_context::StartingContext>();
        // Archive
        types.visit::<crate::usage::machine_health::archive::ArchiveStatus>();
        types.visit::<crate::usage::machine_health::archive::store::FolderCheck>();
        types.visit::<crate::usage::machine_health::archive::imports::ImportPreview>();
        types.visit::<crate::usage::machine_health::archive::tokens::LifetimeTokens>();
        types.visit::<crate::usage::machine_health::archive::export::ArchiveExportRequest>();
        types.visit::<crate::usage::machine_health::archive::export::ArchiveExport>();
    }

    struct Collected {
        config: Config,
        /// Each type's TypeScript name, with the Rust type it came from and the declaration written for it.
        types: BTreeMap<String, (&'static str, String)>,
    }

    impl TypeVisitor for Collected {
        fn visit<T: TS + 'static + ?Sized>(&mut self) {
            // Primitives, lists and maps have no declaration of their own.
            if T::output_path().is_none() {
                return;
            }
            let name = T::ident(&self.config);
            let mut declaration = T::docs().unwrap_or_default();
            declaration.push_str("export ");
            declaration.push_str(&T::decl(&self.config));
            let declaration = layout(&declaration);
            if let Some((rust, seen)) = self.types.get(&name) {
                // ts-rs writes some types through a stand-in of the same name (serde_json's Value), so only a
                // different declaration is two types clashing.
                assert!(
                    *seen == declaration,
                    "{rust} and {} are both called {name} in TypeScript; give one a #[ts(rename = \"...\")]",
                    std::any::type_name::<T>()
                );
                return;
            }
            self.types.insert(name, (std::any::type_name::<T>(), declaration));
            T::visit_dependencies(self);
        }
    }

    /// ts-rs writes each declaration on one line; this puts an object type's fields on lines of their own so the
    /// file reads, and diffs, one field at a time. Anything but a plain object (a union, an alias) stays as it is.
    fn layout(declaration: &str) -> String {
        let Some(open) = declaration.find("= {") else {
            return declaration.to_string();
        };
        let (head, body) = declaration.split_at(open + 3);
        let mut out = String::from(head);
        let mut field = String::new();
        let mut depth = 1_usize;
        let mut quote = None;
        let mut rest = body;
        while let Some(char) = rest.chars().next() {
            if quote.is_none() && rest.starts_with("/*") {
                let end = rest.find("*/").map_or(rest.len(), |end| end + 2);
                if depth == 1 {
                    push_comment(&mut out, &rest[..end]);
                } else {
                    field.push_str(&rest[..end]);
                }
                rest = &rest[end..];
                continue;
            }
            rest = &rest[char.len_utf8()..];
            if let Some(open_quote) = quote {
                field.push(char);
                if char == open_quote {
                    quote = None;
                }
                continue;
            }
            match char {
                '"' | '\'' | '`' => quote = Some(char),
                '{' | '<' | '(' | '[' => depth += 1,
                '}' | '>' | ')' | ']' => depth -= 1,
                _ => {}
            }
            if depth == 0 {
                if rest.trim() != ";" {
                    return declaration.to_string();
                }
                push_field(&mut out, &mut field);
                out.push_str("\n};");
                return out;
            }
            field.push(char);
            if depth == 1 && char == ',' {
                push_field(&mut out, &mut field);
            }
        }
        declaration.to_string()
    }

    fn push_field(out: &mut String, field: &mut String) {
        if !field.trim().is_empty() {
            out.push_str("\n  ");
            out.push_str(field.trim());
        }
        field.clear();
    }

    /// A field's doc comment, indented under the object.
    fn push_comment(out: &mut String, comment: &str) {
        let text = comment.trim_start_matches("/**").trim_start_matches("/*").trim_end_matches("*/");
        let lines: Vec<&str> = text.lines().map(|line| line.trim().trim_start_matches('*').trim()).collect();
        let first = lines.iter().position(|line| !line.is_empty()).unwrap_or(lines.len());
        let last = lines.iter().rposition(|line| !line.is_empty()).map_or(first, |last| last + 1);
        out.push_str("\n  /**");
        for line in &lines[first..last] {
            out.push_str(if line.is_empty() { "\n   *" } else { "\n   * " });
            out.push_str(line);
        }
        out.push_str("\n   */");
    }

    fn render() -> String {
        let mut collected = Collected { config: Config::new().with_large_int("number"), types: BTreeMap::new() };
        command_types(&mut collected);
        let mut out = String::from(HEADER);
        for (_, declaration) in collected.types.values() {
            out.push('\n');
            out.push_str(declaration.trim_end());
            out.push('\n');
        }
        out
    }

    #[test]
    fn the_webview_has_the_types_the_commands_use() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(OUTPUT);
        let rendered = render();
        if std::env::var_os("ARBOR_WRITE_BINDINGS").is_some() {
            std::fs::write(&path, &rendered).unwrap();
            return;
        }
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        if current != rendered {
            let line = current.lines().zip(rendered.lines()).position(|(a, b)| a != b).unwrap_or_else(|| {
                current.lines().count().min(rendered.lines().count())
            });
            panic!(
                "src/native/types.ts doesn't match the Rust types (first difference on line {}). Run `bun run bindings` to rewrite it.",
                line + 1
            );
        }
    }
}
