import { utils, write } from 'xlsx';

export function exportFilename(title, format) {
  let name = String(title || '查询结果').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/g, '');
  if (!name) name = '查询结果';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return `${name}.${format}`;
}

export function exportRangeNote(value) {
  const offset = value.offset ?? 0;
  const total = value.rowCount ?? value.total;
  if (!value.truncated && offset === 0 && !(total > value.data.length)) return '';
  const range = value.data.length ? `第 ${offset + 1}–${offset + value.data.length} 行` : '空结果';
  return `仅导出当前已加载的 ${value.data.length} 行（${range}；offset=${offset}；total=${total ?? '未知'}），未加载的数据未导出。`;
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (typeof value === 'string' && /^[=+\-@\u0000-\u001f\u007f-\u009f]/.test(value)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tableRows(value) {
  return [
    value.columns.map(column => column.title || column.name),
    ...value.data.map(row => value.columns.map(column => row[column.name] ?? '')),
  ];
}

function columnWidths(rows, columnCount) {
  return Array.from({ length: columnCount }, (_, index) => ({
    wch: Math.min(60, Math.max(12, ...rows.map(row => String(row[index] ?? '').length + 2))),
  }));
}

export function createExport(value, format) {
  if (format !== 'csv' && format !== 'xlsx') throw new Error(`不支持的导出格式：${format}`);
  const rows = tableRows(value);
  const note = exportRangeNote(value);
  const filename = exportFilename(value.title, format);
  if (format === 'csv') {
    const lines = rows.map(row => row.map(csvCell).join(','));
    if (note) lines.push('', csvCell(note));
    return { data: `\ufeff${lines.join('\r\n')}\r\n`, mime: 'text/csv;charset=utf-8', filename };
  }

  // aoa_to_sheet keeps string values as text cells, including values beginning with '='.
  const sheet = utils.aoa_to_sheet(rows);
  sheet['!cols'] = columnWidths(rows, value.columns.length);
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, '查询结果');
  if (note) {
    const explanation = utils.aoa_to_sheet([['导出范围说明'], [note]]);
    explanation['!cols'] = [{ wch: 100 }];
    utils.book_append_sheet(workbook, explanation, '导出说明');
  }
  const bytes = write(workbook, { bookType: 'xlsx', type: 'array', compression: true });
  return {
    data: new Uint8Array(bytes),
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename,
  };
}
