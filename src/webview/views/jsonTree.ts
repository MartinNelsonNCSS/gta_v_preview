import { fmt, h } from '../ui';

/** Collapsible JSON tree; children render lazily when first expanded. */
export function jsonTree(value: unknown, key: string, open = false): HTMLElement {
  if (value === null || typeof value !== 'object') {
    return h('div', { class: 'json-leaf' }, h('span', { class: 'json-key' }, key), ': ', h('span', { class: `json-${typeof value}` }, JSON.stringify(value)));
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'number') && value.length <= 4) {
    return h('div', { class: 'json-leaf' }, h('span', { class: 'json-key' }, key), ': ', h('span', { class: 'json-number' }, `[${value.map((v) => fmt(v, 4)).join(', ')}]`));
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value).filter(([k]) => k !== '_type');
  const type = Array.isArray(value) ? `[${value.length}]` : (value as { _type?: string })._type ?? '{}';
  const details = h('details', { class: 'json-node', open }, h('summary', null, h('span', { class: 'json-key' }, key), ' ', h('span', { class: 'muted' }, type)));
  let rendered = false;
  const render = () => {
    if (rendered || !details.open) return;
    rendered = true;
    details.append(h('div', { class: 'json-children' }, entries.map(([k, v]) => jsonTree(v, k))));
  };
  details.addEventListener('toggle', render);
  render();
  return details;
}
