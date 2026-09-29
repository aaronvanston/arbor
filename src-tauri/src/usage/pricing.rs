//! Model prices and what requests cost: the bundled catalog, prices synced from the upstream catalog and models.dev
//! for the models it lacks, the user's own entries, and each group of requests' cost at them.

use super::*;

pub(super) const TOKENS_PER_PRICE_UNIT: f64 = 1_000_000.0;
/// Input sizes above which some models bill the whole request at long-context
/// rates (2× input, 1.5× output). Which one applies, if any, depends on the
/// model; see `long_context_tier`.
pub(super) const LONG_CONTEXT_THRESHOLDS: [u64; 2] = [200_000, 272_000];
pub(super) const BUNDLED_MODEL_PRICE_CATALOG: &str = include_str!("../../resources/model_prices.json");
pub(super) const MODEL_PRICE_SYNC_URL: &str =
    "https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/src-tauri/resources/model_prices.json";
/// Sync fills in models the catalog above doesn't have yet from here. It lists
/// resellers too, so only the labs' own prices are used.
pub(super) const MODELS_DEV_CATALOG_URL: &str = "https://models.dev/api.json";
pub(super) const MODELS_DEV_PROVIDERS: &[&str] = &[
    "anthropic", "openai", "google", "xai", "deepseek", "mistral", "moonshotai", "zai", "minimax",
    "alibaba",
];
pub(super) const MODELS_DEV_PRICE_SOURCE: &str = "models.dev";

#[derive(Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPrice {
    pub(super) model: String,
    pub(super) prompt: f64,
    pub(super) completion: f64,
    pub(super) cache: f64,
    pub(super) cache_read: f64,
    pub(super) cache_creation: f64,
    pub(super) prompt_configured: bool,
    pub(super) completion_configured: bool,
    pub(super) cache_read_configured: bool,
    pub(super) cache_creation_configured: bool,
    pub(super) source: String,
    pub(super) source_model_id: String,
    pub(super) updated_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelPriceCatalog {
    pub(super) schema_version: u8,
    #[serde(default)]
    pub(super) updated_at: String,
    pub(super) models: HashMap<String, CatalogModelPrice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CatalogModelPrice {
    pub(super) input_per_1_m: f64,
    pub(super) output_per_1_m: f64,
    #[serde(default)]
    pub(super) cache_read_per_1_m: Option<f64>,
    #[serde(default)]
    pub(super) cache_creation_per_1_m: Option<f64>,
}

#[derive(Default)]
pub(super) struct CostTokens {
    pub(super) input: u64,
    pub(super) output: u64,
    pub(super) cache_read: u64,
    pub(super) cache_creation: u64,
    pub(super) long_input: u64,
    pub(super) long_output: u64,
    pub(super) long_cache_read: u64,
    pub(super) long_cache_creation: u64,
}

/// A cost in USD, split by what it paid for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(super) struct CostParts {
    /// Input that wasn't read from or written to the cache.
    pub(super) input: f64,
    pub(super) cache_read: f64,
    pub(super) cache_write: f64,
    pub(super) output: f64,
}

impl CostParts {
    pub(super) fn total(&self) -> f64 {
        self.input + self.cache_read + self.cache_write + self.output
    }
}

#[derive(Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsagePricing {
    pub(super) rows: Vec<UsagePriceRow>,
    pub(super) total_cost: f64,
    pub(super) total_requests: u64,
    pub(super) priced_requests: u64,
    pub(super) saved_prices: usize,
}

#[derive(Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(super) struct UsagePriceRow {
    pub(super) model: String,
    pub(super) requests: u64,
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) cache_read_tokens: u64,
    pub(super) cache_creation_tokens: u64,
    pub(super) total_tokens: u64,
    pub(super) estimated_cost: f64,
    pub(super) price: Option<ModelPrice>,
}

#[derive(Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPriceSyncResult {
    pub(super) imported: usize,
    pub(super) skipped: usize,
    /// Used models priced from models.dev because the catalog doesn't have them.
    pub(super) filled: Vec<String>,
    pub(super) unmatched: Vec<String>,
    pub(super) used_builtin: bool,
}

pub(super) struct UsageCostGroup {
    pub(super) model: String,
    pub(super) alias: String,
    pub(super) service_tier: String,
    pub(super) response_service_tier: String,
    pub(super) executor_type: String,
    pub(super) provider: String,
    pub(super) auth_type: String,
    pub(super) requests: u64,
    pub(super) tokens: CostTokens,
    pub(super) total_tokens: u64,
}

pub(super) fn load_usage_cost_groups(
    connection: &Connection,
    filter: &UsageSqlFilter,
) -> Result<Vec<UsageCostGroup>, String> {
    let groups = cost_groups::fold_cost_rows::<()>(connection, &[], "", filter, |_, _, _| Ok(()))?;
    Ok(groups.into_iter().map(|group| group.cost).collect())
}

/// The long-context tier of a request's model, or of its alias when the model has none.
pub(super) fn billed_long_context_tier(model: &str, alias: &str) -> Option<usize> {
    long_context_tier(model).or_else(|| long_context_tier(alias))
}

/// One request's tokens for costing, with its long-context share set the way
/// cost_groups sums it.
pub(super) fn request_cost_tokens(
    model: &str,
    alias: &str,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
) -> CostTokens {
    let long = billed_long_context_tier(model, alias)
        .is_some_and(|tier| input > LONG_CONTEXT_THRESHOLDS[tier]);
    let long_share = |tokens: u64| if long { tokens } else { 0 };
    CostTokens {
        input,
        output,
        cache_read,
        cache_creation,
        long_input: long_share(input),
        long_output: long_share(output),
        long_cache_read: long_share(cache_read),
        long_cache_creation: long_share(cache_creation),
    }
}

/// Which of LONG_CONTEXT_THRESHOLDS a model's long-context rates start at,
/// following LiteLLM's `input_cost_per_token_above_*_tokens` prices. None for
/// models that bill every request the same, like the Claude 5 family.
pub(super) fn long_context_tier(model: &str) -> Option<usize> {
    // A context-size tag like claude-sonnet-4-5[1m] names the same model.
    let model = model.split('[').next().unwrap_or(model);
    const FROM_200K: [&str; 5] = [
        "claude-sonnet-4-20250514",
        "claude-sonnet-4-5",
        "gemini-2.5-pro",
        "gemini-3-pro",
        "gemini-3.1-pro",
    ];
    const FROM_272K: [&str; 6] = ["gpt-5.4", "gpt-5.5", "gpt-5.6", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
    if FROM_200K.iter().any(|family| is_model_family(model, family)) {
        Some(0)
    } else if FROM_272K.iter().any(|family| is_model_family(model, family)) {
        Some(1)
    } else {
        None
    }
}

pub(super) fn sum_usage_cost(groups: &[UsageCostGroup], prices: &HashMap<String, ModelPrice>) -> (f64, u64) {
    let mut total_cost = 0.0;
    let mut priced_requests = 0_u64;
    for group in groups {
        let Some(cost) = cost_for_usage_group(group, prices) else {
            continue;
        };
        total_cost += cost;
        priced_requests = priced_requests.saturating_add(group.requests);
    }
    (total_cost, priced_requests)
}

/// None when neither the model nor its alias has a price.
pub(super) fn cost_for_usage_group(
    group: &UsageCostGroup,
    prices: &HashMap<String, ModelPrice>,
) -> Option<f64> {
    cost_parts_for_usage_group(group, prices).map(|parts| parts.total())
}

pub(super) fn cost_parts_for_usage_group(
    group: &UsageCostGroup,
    prices: &HashMap<String, ModelPrice>,
) -> Option<CostParts> {
    let (model, price) = resolve_model_price(&group.model, &group.alias, prices)?;
    Some(cost_parts_for_price(
        model,
        billed_service_tier(group),
        &group.tokens,
        &price,
    ))
}

/// The service tier a group was billed at: the one the response reported,
/// except for Codex, whose requests name the tier they asked for.
pub(super) fn billed_service_tier(group: &UsageCostGroup) -> &str {
    let identity = format!(
        "{} {} {}",
        group.executor_type, group.provider, group.auth_type
    )
    .to_ascii_lowercase();
    if identity.contains("codex") || group.response_service_tier.trim().is_empty() {
        group.service_tier.as_str()
    } else {
        group.response_service_tier.as_str()
    }
}

pub(super) fn cost_for_price(model: &str, service_tier: &str, tokens: &CostTokens, price: &ModelPrice) -> f64 {
    cost_parts_for_price(model, service_tier, tokens, price).total()
}

pub(super) fn cost_parts_for_price(
    model: &str,
    service_tier: &str,
    tokens: &CostTokens,
    price: &ModelPrice,
) -> CostParts {
    cost_parts_at_price(model, service_tier, tokens, &enriched_model_price(model, price))
}

/// cost_parts_for_price for a price enriched_model_price has already filled in.
pub(super) fn cost_parts_at_price(
    model: &str,
    service_tier: &str,
    tokens: &CostTokens,
    price: &ModelPrice,
) -> CostParts {
    let short_cost = cost_for_token_segment(
        tokens.input.saturating_sub(tokens.long_input),
        tokens.output.saturating_sub(tokens.long_output),
        tokens.cache_read.saturating_sub(tokens.long_cache_read),
        tokens
            .cache_creation
            .saturating_sub(tokens.long_cache_creation),
        price,
        1.0,
        1.0,
    );
    let long_cost = cost_for_token_segment(
        tokens.long_input,
        tokens.long_output,
        tokens.long_cache_read,
        tokens.long_cache_creation,
        price,
        2.0,
        1.5,
    );
    let tier = service_tier.trim().to_ascii_lowercase();
    let multiplier = if tokens.long_input > 0 && matches!(tier.as_str(), "priority" | "fast") {
        1.0
    } else {
        match tier.as_str() {
            "flex" | "batch" => 0.5,
            "priority" | "fast" => service_tier_multiplier(model),
            _ => 1.0,
        }
    };
    CostParts {
        input: (short_cost.input + long_cost.input) * multiplier,
        cache_read: (short_cost.cache_read + long_cost.cache_read) * multiplier,
        cache_write: (short_cost.cache_write + long_cost.cache_write) * multiplier,
        output: (short_cost.output + long_cost.output) * multiplier,
    }
}

pub(super) fn cost_for_token_segment(
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    price: &ModelPrice,
    input_multiplier: f64,
    output_multiplier: f64,
) -> CostParts {
    let prompt = input.saturating_sub(cache_read.saturating_add(cache_creation));
    let input_cost = |tokens: u64, rate: f64| tokens as f64 * rate * input_multiplier / TOKENS_PER_PRICE_UNIT;
    CostParts {
        input: input_cost(prompt, price.prompt),
        cache_read: input_cost(cache_read, price.cache_read),
        cache_write: input_cost(cache_creation, price.cache_creation),
        output: output as f64 * price.completion * output_multiplier / TOKENS_PER_PRICE_UNIT,
    }
}

pub(super) fn official_model_price(model: &str) -> Option<ModelPrice> {
    find_model_price(cached_bundled_model_prices().ok()?, model).cloned()
}

pub(super) fn bundled_model_prices() -> Result<HashMap<String, ModelPrice>, String> {
    cached_bundled_model_prices().cloned()
}

pub(super) fn cached_bundled_model_prices() -> Result<&'static HashMap<String, ModelPrice>, String> {
    static PRICES: LazyLock<Result<HashMap<String, ModelPrice>, String>> =
        LazyLock::new(|| parse_model_price_catalog(BUNDLED_MODEL_PRICE_CATALOG, "builtin", 0));
    PRICES.as_ref().map_err(Clone::clone)
}

pub(super) fn parse_model_price_catalog(
    content: &str,
    source: &str,
    updated_at_ms: i64,
) -> Result<HashMap<String, ModelPrice>, String> {
    let catalog = serde_json::from_str::<ModelPriceCatalog>(content)
        .map_err(|error| format!("Failed to parse model pricing file: {error}"))?;
    if catalog.schema_version != 1 {
        return Err(format!(
            "Unsupported model pricing file version {}",
            catalog.schema_version
        ));
    }
    if catalog.models.is_empty() {
        return Err("Model pricing file contains no models".to_string());
    }
    let _catalog_updated_at = catalog.updated_at;
    let mut prices = HashMap::with_capacity(catalog.models.len());
    for (model, entry) in catalog.models {
        let cache_read = entry.cache_read_per_1_m.unwrap_or(0.0);
        let cache_creation = entry.cache_creation_per_1_m.unwrap_or(0.0);
        let price = ModelPrice {
            model: model.trim().to_string(),
            prompt: entry.input_per_1_m,
            completion: entry.output_per_1_m,
            cache: cache_read,
            cache_read,
            cache_creation,
            prompt_configured: true,
            completion_configured: true,
            cache_read_configured: entry.cache_read_per_1_m.is_some(),
            cache_creation_configured: entry.cache_creation_per_1_m.is_some(),
            source: source.to_string(),
            source_model_id: String::new(),
            updated_at_ms,
        };
        validate_model_price(&price)?;
        prices.insert(price.model.clone(), price);
    }
    Ok(prices)
}

pub(super) fn find_model_price<'a>(
    prices: &'a HashMap<String, ModelPrice>,
    model: &str,
) -> Option<&'a ModelPrice> {
    match_model_price(prices, model).map(|(price, _)| price)
}

/// How a model name found its price.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum PriceMatch {
    Exact,
    /// The name only starts with a priced model's name, such as a dated or
    /// suffixed variant. Holds that name's length; longer is closer.
    Guess(usize),
}

pub(super) fn match_model_price<'a>(
    prices: &'a HashMap<String, ModelPrice>,
    model: &str,
) -> Option<(&'a ModelPrice, PriceMatch)> {
    if let Some(price) = prices.get(model) {
        return Some((price, PriceMatch::Exact));
    }
    let case_insensitive = prices
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(model))
        .collect::<Vec<_>>();
    if case_insensitive.len() == 1 {
        return Some((case_insensitive[0].1, PriceMatch::Exact));
    }
    let tail = canonical_model_tail(model);
    let exact_tail = prices
        .iter()
        .filter(|(key, _)| canonical_model_tail(key) == tail)
        .collect::<Vec<_>>();
    if exact_tail.len() == 1 {
        return Some((exact_tail[0].1, PriceMatch::Exact));
    }
    let normalized_tail = normalized_model_tail(model);
    prices
        .iter()
        .filter_map(|(key, price)| {
            let key_tail = normalized_model_tail(key);
            normalized_tail
                .starts_with(&format!("{key_tail}-"))
                .then_some((key_tail.len(), price))
        })
        .max_by_key(|(length, _)| *length)
        .map(|(length, price)| (price, PriceMatch::Guess(length)))
}

pub(super) fn resolve_model_price<'a>(
    model: &'a str,
    alias: &'a str,
    prices: &HashMap<String, ModelPrice>,
) -> Option<(&'a str, ModelPrice)> {
    for candidate in [model, alias] {
        if candidate.trim().is_empty() {
            continue;
        }
        if let Some(price) = find_model_price(prices, candidate) {
            return Some((model, price.clone()));
        }
    }
    None
}

pub(super) fn enriched_model_price(model: &str, price: &ModelPrice) -> ModelPrice {
    let mut price = price.clone();
    if let Some(official) = official_model_price(model) {
        if !price.prompt_configured && price.prompt <= 0.0 {
            price.prompt = official.prompt;
        }
        if !price.completion_configured && price.completion <= 0.0 {
            price.completion = official.completion;
        }
    }
    if !price.cache_read_configured && price.cache_read <= 0.0 {
        price.cache_read = if price.cache > 0.0 {
            price.cache
        } else {
            price.prompt * 0.1
        };
    }
    if !price.cache_creation_configured && price.cache_creation <= 0.0 {
        price.cache_creation = price.prompt
            * if is_model_family(model, "gpt-5.6") {
                1.25
            } else {
                1.0
            };
    }
    price
}

/// Whether `model`, past any "provider/" prefix and in any case, is `family`
/// (always lower case) or a version of it. It runs for every request priced, so
/// it compares in place rather than making a lower-case copy.
pub(super) fn is_model_family(model: &str, family: &str) -> bool {
    let name = model.trim().rsplit('/').next().unwrap_or_default().as_bytes();
    let family = family.as_bytes();
    name.len() >= family.len()
        && name[..family.len()].eq_ignore_ascii_case(family)
        && (name.len() == family.len() || name[family.len()] == b'-')
}

pub(super) fn service_tier_multiplier(model: &str) -> f64 {
    if is_model_family(model, "gpt-5.5") {
        2.5
    } else if is_model_family(model, "gpt-6-astra")
        || is_model_family(model, "gpt-6-sol")
        || is_model_family(model, "gpt-6-luna")
        || is_model_family(model, "gpt-5.6")
        || is_model_family(model, "gpt-5.4")
        || is_model_family(model, "gpt-5.4-mini")
        || is_model_family(model, "gpt-5.3-codex")
    {
        2.0
    } else {
        1.0
    }
}

pub(super) fn load_model_prices(connection: &Connection) -> Result<HashMap<String, ModelPrice>, String> {
    load_saved_model_prices(connection, true)
}

/// The bundled prices with saved ones on top. Without `filled`, prices that
/// Sync filled in from models.dev are left out.
pub(super) fn load_saved_model_prices(
    connection: &Connection,
    filled: bool,
) -> Result<HashMap<String, ModelPrice>, String> {
    let mut merged = bundled_model_prices()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT model, prompt_per_1m, completion_per_1m, cache_per_1m,
                   cache_read_per_1m, cache_creation_per_1m,
                   prompt_configured, completion_configured,
                   cache_read_configured, cache_creation_configured,
                   source, source_model_id, updated_at_ms
            FROM model_prices ORDER BY model
            "#,
        )
        .map_err(|error| format!("Failed to prepare model pricing query: {error}"))?;
    let prices = statement
        .query_map([], |row| {
            Ok(ModelPrice {
                model: row.get(0)?,
                prompt: row.get(1)?,
                completion: row.get(2)?,
                cache: row.get(3)?,
                cache_read: row.get(4)?,
                cache_creation: row.get(5)?,
                prompt_configured: row.get(6)?,
                completion_configured: row.get(7)?,
                cache_read_configured: row.get(8)?,
                cache_creation_configured: row.get(9)?,
                source: row.get(10)?,
                source_model_id: row.get(11)?,
                updated_at_ms: row.get(12)?,
            })
        })
        .map_err(|error| format!("Failed to query model pricing: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read model pricing: {error}"))?;
    for price in prices {
        if price.source != "litellm" && (filled || price.source != MODELS_DEV_PRICE_SOURCE) {
            if let Some(existing) = merged
                .keys()
                .find(|model| model.eq_ignore_ascii_case(&price.model))
                .cloned()
            {
                merged.remove(&existing);
            }
            merged.insert(price.model.clone(), price);
        }
    }
    Ok(merged)
}

pub(super) fn validate_model_price(price: &ModelPrice) -> Result<(), String> {
    if price.model.trim().is_empty() {
        return Err("Model name cannot be empty".to_string());
    }
    for value in [
        price.prompt,
        price.completion,
        price.cache,
        price.cache_read,
        price.cache_creation,
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(format!("Model {} contains invalid pricing", price.model));
        }
    }
    Ok(())
}

pub(super) fn upsert_model_price(connection: &Connection, price: &ModelPrice) -> Result<(), String> {
    validate_model_price(price)?;
    connection
        .execute(
            r#"
            INSERT INTO model_prices (
                model, prompt_per_1m, completion_per_1m, cache_per_1m,
                cache_read_per_1m, cache_creation_per_1m,
                prompt_configured, completion_configured,
                cache_read_configured, cache_creation_configured,
                source, source_model_id, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(model) DO UPDATE SET
                prompt_per_1m = excluded.prompt_per_1m,
                completion_per_1m = excluded.completion_per_1m,
                cache_per_1m = excluded.cache_per_1m,
                cache_read_per_1m = excluded.cache_read_per_1m,
                cache_creation_per_1m = excluded.cache_creation_per_1m,
                prompt_configured = excluded.prompt_configured,
                completion_configured = excluded.completion_configured,
                cache_read_configured = excluded.cache_read_configured,
                cache_creation_configured = excluded.cache_creation_configured,
                source = excluded.source,
                source_model_id = excluded.source_model_id,
                updated_at_ms = excluded.updated_at_ms
            "#,
            params![
                price.model.trim(),
                price.prompt,
                price.completion,
                price.cache,
                price.cache_read,
                price.cache_creation,
                price.prompt_configured,
                price.completion_configured,
                price.cache_read_configured,
                price.cache_creation_configured,
                price.source,
                price.source_model_id,
                price.updated_at_ms,
            ],
        )
        .map_err(|error| format!("Failed to save model pricing: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn get_usage_pricing(query: UsageQuery) -> Result<UsagePricing, String> {
    run_usage_task(move || load_usage_pricing(&open_usage_database()?, &query)).await
}

pub(super) fn load_usage_pricing(connection: &Connection, query: &UsageQuery) -> Result<UsagePricing, String> {
    let filter = build_usage_filter(query);
    let prices = load_model_prices(connection)?;
    let groups = load_usage_cost_groups(connection, &filter)?;
    let mut rows = HashMap::<String, UsagePriceRow>::new();
    let mut total_requests = 0_u64;
    let mut priced_requests = 0_u64;
    let mut total_cost = 0.0;
    for group in &groups {
        total_requests = total_requests.saturating_add(group.requests);
        let entry = rows
            .entry(group.model.clone())
            .or_insert_with(|| UsagePriceRow {
                model: group.model.clone(),
                ..UsagePriceRow::default()
            });
        entry.requests = entry.requests.saturating_add(group.requests);
        entry.input_tokens = entry.input_tokens.saturating_add(group.tokens.input);
        entry.output_tokens = entry.output_tokens.saturating_add(group.tokens.output);
        entry.cache_read_tokens = entry
            .cache_read_tokens
            .saturating_add(group.tokens.cache_read);
        entry.cache_creation_tokens = entry
            .cache_creation_tokens
            .saturating_add(group.tokens.cache_creation);
        entry.total_tokens = entry.total_tokens.saturating_add(group.total_tokens);

        if let Some((model, price)) = resolve_model_price(&group.model, &group.alias, &prices) {
            let cost = cost_for_price(model, billed_service_tier(group), &group.tokens, &price);
            entry.estimated_cost += cost;
            entry.price = Some(price);
            total_cost += cost;
            priced_requests = priced_requests.saturating_add(group.requests);
        }
    }
    for price in prices.values() {
        rows.entry(price.model.clone())
            .or_insert_with(|| UsagePriceRow {
                model: price.model.clone(),
                price: Some(price.clone()),
                ..UsagePriceRow::default()
            });
    }
    let mut rows = rows.into_values().collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        left.price
            .is_some()
            .cmp(&right.price.is_some())
            .then_with(|| right.requests.cmp(&left.requests))
            .then_with(|| left.model.cmp(&right.model))
    });
    Ok(UsagePricing {
        rows,
        total_cost,
        total_requests,
        priced_requests,
        saved_prices: prices.len(),
    })
}

#[tauri::command]
pub(crate) async fn save_usage_model_price(mut price: ModelPrice) -> Result<(), String> {
    price.model = price.model.trim().to_string();
    price.source = "manual".to_string();
    price.source_model_id.clear();
    price.updated_at_ms = Local::now().timestamp_millis();
    run_usage_task(move || upsert_model_price(&open_usage_database()?, &price)).await
}

#[tauri::command]
pub(crate) async fn delete_usage_model_price(model: String) -> Result<(), String> {
    run_usage_task(move || {
        let connection = open_usage_database()?;
        connection
            .execute(
                "DELETE FROM model_prices WHERE model = ?1 COLLATE NOCASE",
                params![model.trim()],
            )
            .map_err(|error| format!("Failed to delete model pricing: {error}"))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn sync_usage_model_prices(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<ModelPriceSyncResult, String> {
    let config = gui_config_state.snapshot()?;
    let client_builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30));
    let proxy_url = config.proxy_url.trim();
    let client = if proxy_url.is_empty() {
        client_builder.build().ok()
    } else {
        apply_configured_proxy(client_builder, proxy_url)
            .ok()
            .and_then(|builder| builder.build().ok())
    };
    let remote_content = fetch_price_catalog(client.as_ref(), MODEL_PRICE_SYNC_URL).await;
    let now = Local::now().timestamp_millis();
    let (remote_prices, used_builtin) = match remote_content
        .as_deref()
        .and_then(|content| parse_model_price_catalog(content, "github", now).ok())
    {
        Some(prices) => (prices, false),
        None => (bundled_model_prices()?, true),
    };

    let (result, needs_fill) = run_usage_task(move || {
        let mut connection = open_usage_database()?;
        let current_prices = load_model_prices(&connection)?;
        let manual_models = current_prices
            .values()
            .filter(|price| price.source == "manual")
            .map(|price| price.model.to_ascii_lowercase())
            .collect::<std::collections::HashSet<_>>();
        let mut result = ModelPriceSyncResult {
            used_builtin,
            ..ModelPriceSyncResult::default()
        };
        if !used_builtin {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("Failed to start model pricing update: {error}"))?;
            transaction
                .execute("DELETE FROM model_prices WHERE source = 'github'", [])
                .map_err(|error| format!("Failed to clear old model pricing: {error}"))?;
            for price in remote_prices.values() {
                if manual_models.contains(&price.model.to_ascii_lowercase()) {
                    result.skipped += 1;
                    continue;
                }
                upsert_model_price(&transaction, price)?;
                result.imported += 1;
            }
            transaction
                .commit()
                .map_err(|error| format!("Failed to commit model pricing update: {error}"))?;
        } else {
            connection
                .execute("DELETE FROM model_prices WHERE source = 'github'", [])
                .map_err(|error| format!("Failed to restore built-in model pricing: {error}"))?;
        }
        let curated = load_saved_model_prices(&connection, false)?;
        let needs_fill = used_models(&connection)?.iter().any(|model| {
            !matches!(match_model_price(&curated, model), Some((_, PriceMatch::Exact)))
        });
        Ok((result, needs_fill))
    })
    .await?;

    // Only download models.dev when something is missing. If it can't be read,
    // the prices filled in last time stay.
    let models_dev = if needs_fill {
        fetch_price_catalog(client.as_ref(), MODELS_DEV_CATALOG_URL)
            .await
            .and_then(|content| parse_models_dev_prices(&content, now).ok())
    } else {
        Some(HashMap::new())
    };

    run_usage_task(move || {
        let mut connection = open_usage_database()?;
        let mut result = result;
        if let Some(models_dev) = models_dev {
            result.filled = replace_filled_model_prices(&mut connection, &models_dev)?;
        }
        let filter = build_usage_filter(&query);
        let models = load_usage_cost_groups(&connection, &filter)?
            .into_iter()
            .map(|group| group.model)
            .collect::<std::collections::BTreeSet<_>>();
        let effective_prices = load_model_prices(&connection)?;
        for model in models {
            if resolve_model_price(&model, "", &effective_prices).is_none() {
                result.unmatched.push(model);
            }
        }
        Ok(result)
    })
    .await
}

pub(super) async fn fetch_price_catalog(client: Option<&reqwest::Client>, url: &str) -> Option<String> {
    match client?.get(url).send().await {
        Ok(response) if response.status().is_success() => response.text().await.ok(),
        _ => None,
    }
}

/// The labs' own prices in the models.dev catalog, by model id. Models without
/// a price, or priced at nothing, are left out.
pub(super) fn parse_models_dev_prices(
    content: &str,
    updated_at_ms: i64,
) -> Result<HashMap<String, ModelPrice>, String> {
    let catalog = serde_json::from_str::<Value>(content)
        .map_err(|error| format!("Failed to parse the models.dev catalog: {error}"))?;
    let mut prices = HashMap::new();
    for provider in MODELS_DEV_PROVIDERS {
        let Some(models) = catalog
            .get(provider)
            .and_then(|entry| entry.get("models"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        for (key, entry) in models {
            let id = entry.get("id").and_then(Value::as_str).unwrap_or(key).trim();
            let Some(cost) = entry.get("cost") else {
                continue;
            };
            let rate = |field: &str| cost.get(field).and_then(Value::as_f64);
            let (Some(prompt), Some(completion)) = (rate("input"), rate("output")) else {
                continue;
            };
            if id.is_empty() || prices.contains_key(id) || (prompt <= 0.0 && completion <= 0.0) {
                continue;
            }
            let cache_read = rate("cache_read");
            let cache_creation = rate("cache_write");
            let price = ModelPrice {
                model: id.to_string(),
                prompt,
                completion,
                cache: cache_read.unwrap_or(0.0),
                cache_read: cache_read.unwrap_or(0.0),
                cache_creation: cache_creation.unwrap_or(0.0),
                prompt_configured: true,
                completion_configured: true,
                cache_read_configured: cache_read.is_some(),
                cache_creation_configured: cache_creation.is_some(),
                source: MODELS_DEV_PRICE_SOURCE.to_string(),
                source_model_id: format!("{provider}/{id}"),
                updated_at_ms,
            };
            if validate_model_price(&price).is_ok() {
                prices.insert(price.model.clone(), price);
            }
        }
    }
    if prices.is_empty() {
        return Err("The models.dev catalog has no prices".to_string());
    }
    Ok(prices)
}

pub(super) fn used_models(connection: &Connection) -> Result<std::collections::BTreeSet<String>, String> {
    let mut statement = connection
        .prepare("SELECT DISTINCT model FROM usage_events WHERE model <> ''")
        .map_err(|error| format!("Failed to prepare used models query: {error}"))?;
    let models = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Failed to query used models: {error}"))?
        .collect::<Result<_, _>>()
        .map_err(|error| format!("Failed to read used models: {error}"))?;
    Ok(models)
}

/// Prices for the used models that the curated prices don't have exactly,
/// saved under the name the requests used. A model the curated prices can
/// only guess at, such as a newer sibling of a priced model, is filled when
/// models.dev has it or a closer relative.
pub(super) fn model_price_fills(
    used: &std::collections::BTreeSet<String>,
    curated: &HashMap<String, ModelPrice>,
    models_dev: &HashMap<String, ModelPrice>,
) -> Vec<ModelPrice> {
    used.iter()
        .filter_map(|model| {
            let guess = match match_model_price(curated, model) {
                Some((_, PriceMatch::Exact)) => return None,
                Some((_, PriceMatch::Guess(length))) => length,
                None => 0,
            };
            let (price, found) = match_model_price(models_dev, model)?;
            if matches!(found, PriceMatch::Guess(length) if length <= guess) {
                return None;
            }
            Some(ModelPrice {
                model: model.clone(),
                ..price.clone()
            })
        })
        .collect()
}

/// Replaces the prices filled in from models.dev by the last sync, and returns
/// the models filled this time.
pub(super) fn replace_filled_model_prices(
    connection: &mut Connection,
    models_dev: &HashMap<String, ModelPrice>,
) -> Result<Vec<String>, String> {
    let fills = model_price_fills(
        &used_models(connection)?,
        &load_saved_model_prices(connection, false)?,
        models_dev,
    );
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start model pricing update: {error}"))?;
    transaction
        .execute(
            "DELETE FROM model_prices WHERE source = ?1",
            params![MODELS_DEV_PRICE_SOURCE],
        )
        .map_err(|error| format!("Failed to clear filled model pricing: {error}"))?;
    for price in &fills {
        upsert_model_price(&transaction, price)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit model pricing update: {error}"))?;
    Ok(fills.into_iter().map(|price| price.model).collect())
}

pub(super) fn canonical_model_tail(value: &str) -> String {
    normalized_model_tail(value)
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

pub(super) fn normalized_model_tail(value: &str) -> String {
    value
        .trim()
        .rsplit('/')
        .find(|part| !part.trim().is_empty() && !part.eq_ignore_ascii_case("models"))
        .unwrap_or(value)
        .to_ascii_lowercase()
}
