import { estimateGraphicsSize, OptimizeOptions, planTexture, TexturePlan } from '../../formats/optimize';
import type { OptimizerFile } from '../../shared/model';
import { checkbox, h, onHostMessage, pref, setPref, vscode } from '../ui';

const MiB = 1024 * 1024;
const size = (n: number) => (n >= MiB ? `${(n / MiB).toFixed(2)} MiB` : `${Math.max(1, Math.round(n / 1024))} KB`);

interface FileState {
  file: OptimizerFile;
  plans: TexturePlan[];
  /** Texture names the user has unticked. */
  excluded: Set<string>;
  el: HTMLElement;
  status: HTMLElement;
}

/**
 * Batch texture optimiser: shows what would change in each .ytd under the
 * chosen options, with exact memory estimates, then applies the selection.
 */
export function optimizerView(scope: string, files: OptimizerFile[]): HTMLElement {
  const options: OptimizeOptions = {
    maxSize: pref('optMaxSize', 2048),
    addMips: pref('optAddMips', true),
    compress: pref('optCompress', true),
  };
  const maxSelect = h(
    'select',
    { onchange: () => ((options.maxSize = Number(maxSelect.value)), setPref('optMaxSize', options.maxSize), replan()) },
    [0, 4096, 2048, 1024, 512].map((n) => h('option', { value: String(n), selected: n === options.maxSize }, n ? `At most ${n} px` : 'No size limit'))
  );
  const summary = h('div', { class: 'opt-summary' });
  const list = h('div', { class: 'opt-list' });
  const apply = h('button', { class: 'chip active' }, 'Optimize selected');
  let states: FileState[] = [];

  const selectedPlans = (s: FileState) => s.plans.filter((p) => !p.blocked && !s.excluded.has(p.name));

  /** Estimated physical memory of a file with its selected plans applied. */
  const estimate = (s: FileState) => {
    const sel = new Map(selectedPlans(s).map((p) => [p.name, p]));
    return sel.size ? estimateGraphicsSize(s.file.textures.map((t) => sel.get(t.name)?.size ?? t.size)) : s.file.graphicsSize;
  };

  const renderSummary = () => {
    const active = states.filter((s) => selectedPlans(s).length);
    const before = active.reduce((n, s) => n + s.file.graphicsSize, 0);
    const after = active.reduce((n, s) => n + estimate(s), 0);
    const count = active.reduce((n, s) => n + selectedPlans(s).length, 0);
    const untouched = files.length - states.length;
    summary.replaceChildren(
      count
        ? h('span', null, h('strong', null, `${count} texture${count === 1 ? '' : 's'}`), ` in ${active.length} dictionar${active.length === 1 ? 'y' : 'ies'}: physical memory `, h('strong', null, `${size(before)} → ${size(after)}`), ` (saves ${size(before - after)})`)
        : h('span', null, 'Nothing to optimise with these options.'),
      ...(untouched ? [h('span', { class: 'muted' }, ` · ${untouched} dictionar${untouched === 1 ? 'y is' : 'ies are'} already fine`)] : [])
    );
    apply.disabled = !count;
  };

  const renderFile = (s: FileState) => {
    const est = estimate(s);
    const all = h('input', {
      type: 'checkbox',
      checked: selectedPlans(s).length === s.plans.filter((p) => !p.blocked).length,
      onchange: () => {
        if (all.checked) s.excluded.clear();
        else s.plans.forEach((p) => s.excluded.add(p.name));
        renderFile(s);
        renderSummary();
      },
    });
    s.el.replaceChildren(
      h(
        'div',
        { class: 'opt-file' },
        all,
        h('strong', null, s.file.file),
        h('span', { class: 'muted' }, `${s.file.resource}/${s.file.rel}`),
        h('span', { class: 'spacer' }),
        h('span', null, `${size(s.file.graphicsSize)} → ${size(est)}`),
        s.status
      ),
      h(
        'table',
        { class: 'data-table opt-table' },
        h('tbody', null, s.plans.map((p) => {
          const t = s.file.textures.find((x) => x.name === p.name)!;
          const box = h('input', {
            type: 'checkbox',
            checked: !p.blocked && !s.excluded.has(p.name),
            disabled: !!p.blocked,
            onchange: () => {
              if (box.checked) s.excluded.delete(p.name);
              else s.excluded.add(p.name);
              renderFile(s);
              renderSummary();
            },
          });
          return h(
            'tr',
            { class: p.blocked ? 'muted' : '' },
            h('td', null, box),
            h('td', null, p.name),
            h('td', null, `${t.width}×${t.height} ${t.format} · ${t.levels} mip${t.levels === 1 ? '' : 's'}`),
            h('td', null, p.blocked ? `can't: ${p.blocked}` : p.reasons.join(', ')),
            h('td', { class: 'num' }, `${size(t.size)} → ${size(p.size)}`)
          );
        }))
      )
    );
  };

  const replan = () => {
    states = files
      .map((file) => {
        const previous = states.find((s) => s.file.uri === file.uri);
        const plans = file.textures.map((t) => planTexture(t, options)).filter((p): p is TexturePlan => !!p);
        return { file, plans, excluded: previous?.excluded ?? new Set<string>(), el: previous?.el ?? h('div', { class: 'opt-file-block' }), status: previous?.status ?? h('span', { class: 'muted' }) };
      })
      .filter((s) => s.plans.length);
    states.forEach(renderFile);
    list.replaceChildren(...states.map((s) => s.el));
    renderSummary();
  };

  apply.onclick = () => {
    const jobs = states.map((s) => ({ uri: s.file.uri, plans: selectedPlans(s) })).filter((j) => j.plans.length);
    if (!jobs.length) return;
    apply.disabled = true;
    for (const s of states) s.status.textContent = selectedPlans(s).length ? ' · waiting…' : '';
    vscode.postMessage({ type: 'applyOptimization', files: jobs });
  };

  onHostMessage((m) => {
    if (m.type === 'optimizeProgress') {
      const s = states.find((x) => x.file.uri === m.uri);
      if (!s) return;
      s.status.textContent = m.ok
        ? ` · ✓ now ${size(m.after!)}${m.skipped?.length ? ` (${m.skipped.length} skipped: ${m.skipped.map((k) => `${k.name} — ${k.reason}`).join('; ')})` : ''}`
        : ` · failed: ${m.error}`;
      s.status.className = m.ok ? 'opt-ok' : 'opt-bad';
    } else if (m.type === 'optimizeDone') {
      apply.disabled = false;
      if (m.cancelled) for (const s of states) s.status.textContent = '';
    }
  });

  replan();
  return h(
    'div',
    { class: 'ytyp-view' },
    h(
      'div',
      { class: 'toolbar' },
      h('strong', null, `Optimize textures — ${scope}`),
      h('label', { class: 'toggle' }, 'Size', maxSelect),
      checkbox('Add missing mipmaps', 'optAddMips', true, (v) => ((options.addMips = v), replan())),
      checkbox('Compress uncompressed', 'optCompress', true, (v) => ((options.compress = v), replan())),
      h('span', { class: 'spacer' }),
      apply
    ),
    summary,
    list
  );
}
