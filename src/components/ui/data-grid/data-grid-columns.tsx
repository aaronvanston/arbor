import type { RowData } from '@tanstack/react-table';
import { Columns3, RotateCcw } from '../icons';
import { useI18n } from '../../../i18n';
import { Button } from '../button';
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../menu';
import type { DataGrid } from './data-grid';
import { applyPreset, matchingPreset, type DataGridLayout, type DataGridPreset } from './data-grid-layout';

/**
 * The grid's Columns menu: its column sets, a tick for each column (in the order they show) and a reset back to
 * `defaultLayout`. It stays open while columns are ticked, so several can change at once.
 */
export function DataGridColumnsMenu<TData extends RowData>({ grid, presets = [], defaultLayout }: {
  grid: DataGrid<TData>;
  presets?: DataGridPreset[];
  defaultLayout: () => DataGridLayout;
}) {
  const { t } = useI18n();
  const { table, layout, setLayout, layoutColumns } = grid;
  const columns = layout.order.flatMap((id) => {
    const column = table.getColumn(id);
    return column ? [column] : [];
  });
  const shown = columns.filter((column) => column.getIsVisible()).length;

  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="sm" />}>
        <Columns3 />
        {t('dataGrid.columns')}
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-52">
        {presets.length ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>{t('dataGrid.presets')}</MenuGroupLabel>
              <MenuRadioGroup
                value={matchingPreset(layout, presets)?.id ?? ''}
                onValueChange={(id) => {
                  const preset = presets.find((candidate) => candidate.id === id);
                  if (preset) setLayout((current) => applyPreset(current, layoutColumns, preset));
                }}
              >
                {presets.map((preset) => (
                  <MenuRadioItem key={preset.id} value={preset.id}>{preset.label}</MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>{t('dataGrid.show')}</MenuGroupLabel>
          {columns.map((column) => {
            const visible = column.getIsVisible();
            return (
              <MenuCheckboxItem
                key={column.id}
                checked={visible}
                // One column always shows.
                disabled={visible && shown <= 1}
                onCheckedChange={(checked) => column.toggleVisibility(checked)}
              >
                {column.columnDef.meta?.label ?? column.id}
              </MenuCheckboxItem>
            );
          })}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => setLayout(defaultLayout())}>
          <RotateCcw />
          {t('dataGrid.reset')}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
