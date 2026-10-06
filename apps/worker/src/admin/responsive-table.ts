import { message, type MessageKey } from "../i18n/messages.js";
import { escapeHtml } from "./format.js";

export interface ResponsiveColumn<Key extends string = string> {
  readonly key: Key;
  readonly label: MessageKey;
}
interface ResponsiveCell {
  /** Authored view markup; callers escape dynamic values before composing it. */
  readonly html: string;
  readonly className?: string;
}

/** One column definition owns desktop headings, mobile labels and cell order.
 * Labels stay in HTML so both forms use the normal server locale translation.
 * Mobile copies are visual only; assistive technology retains the table headers. */
export function responsiveTableHead(columns: readonly ResponsiveColumn[]): string {
  return '<thead><tr>' + columns.map(column => '<th scope="col" data-column="' + escapeHtml(column.key) + '">'
    + escapeHtml(message(column.label, "en")) + '</th>').join("") + '</tr></thead>';
}

export function responsiveTableCells<Key extends string>(columns: readonly ResponsiveColumn<Key>[], cells: Record<NoInfer<Key>, ResponsiveCell>): string {
  return columns.map(column => {
    const cell = cells[column.key];
    return '<td' + (cell.className ? ' class="' + escapeHtml(cell.className) + '"' : '') + '>'
      + '<span class="table-mobile-label" aria-hidden="true">' + escapeHtml(message(column.label, "en")) + '</span>'
      + cell.html + '</td>';
  }).join("");
}
