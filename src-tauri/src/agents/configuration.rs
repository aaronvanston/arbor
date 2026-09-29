pub(crate) fn set_codex_table_item(
    table: &mut toml_edit::Table,
    key: &str,
    mut item: toml_edit::Item,
) {
    if let (Some(current), Some(next)) = (
        table.get(key).and_then(toml_edit::Item::as_value),
        item.as_value_mut(),
    ) {
        *next.decor_mut() = current.decor().clone();
    }
    *table.entry(key).or_insert(toml_edit::Item::None) = item;
}
