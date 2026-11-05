import type { ModLiveryTemplate, ModLiveryVehicle } from '../../shared/model';
import { canvasToRgba, decodeImage, resizeCanvas, rgbaToPng } from '../imageUtils';
import { textureCanvas } from '../textureCanvas';
import { h, hostRequest, newRequestId, onHostMessage, pref, setPref, vscode } from '../ui';

/*
 * Mod-kit livery maker: the vehicle's kit, a template livery model, your
 * artwork (followed live from your image app, shown over the vehicle's UV
 * template), a name, and where the new livery resource goes.
 */

const SIZES = [512, 1024, 2048, 4096];
const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

export interface ModLiveryView {
  el: HTMLElement;
  /** New workspace data (e.g. after a livery was written); keeps the artwork and messages. */
  update(vehicles: ModLiveryVehicle[], templates: ModLiveryTemplate[], preselect?: string): void;
}

export function modLiveryView(vehicles: ModLiveryVehicle[], templates: ModLiveryTemplate[], preselect?: string): ModLiveryView {
  let vehicle = vehicles.find((v) => v.model === preselect || v.liveries.some((l) => l.modelName.toLowerCase() === preselect)) ?? vehicles[0];
  let template: ModLiveryTemplate | undefined = templates[0];
  let artwork: { canvas: HTMLCanvasElement; name: string } | undefined;
  let uv: { canvas: HTMLCanvasElement; name: string } | undefined;
  let linkId: number | undefined;
  /** Existing livery model being updated (instead of adding a new one). */
  let updating: { modelName: string; uri: string } | undefined;
  let size = pref('modLivery:size', 2048);
  let uvMode = pref<'over' | 'under' | 'off'>('modLivery:uvMode', 'over');
  let uvOpacity = pref('modLivery:uvOpacity', 60);
  let labelEdited = false;
  /** A livery just created: switch to updating it once the workspace data includes it. */
  let justCreated: string | undefined;
  let folder = vehicle ? { uri: vehicle.defaultFolder, path: vehicle.defaultFolderPath } : undefined;

  const el = h('div', { class: 'modlivery' });
  const status = h('div', { class: 'modlivery-status small' });
  const setStatus = (text: string, kind: 'ok' | 'bad' | '' = '') => {
    status.textContent = text;
    status.className = `modlivery-status small${kind ? ` opt-${kind}` : ''}`;
  };

  // -- preview -------------------------------------------------------------------------
  const preview = h('canvas', { class: 'modlivery-preview checker', width: 1024, height: 1024 });
  const draw = () => {
    const ctx = preview.getContext('2d')!;
    ctx.clearRect(0, 0, preview.width, preview.height);
    const layer = (c: HTMLCanvasElement, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.drawImage(c, 0, 0, preview.width, preview.height);
      ctx.globalAlpha = 1;
    };
    if (uv && uvMode === 'under') layer(uv.canvas, uvOpacity / 100);
    if (artwork) layer(artwork.canvas, 1);
    if (uv && uvMode === 'over') layer(uv.canvas, uvOpacity / 100);
    if (!artwork && !uv) {
      ctx.fillStyle = 'rgba(128,128,128,0.6)';
      ctx.font = '40px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Choose or follow your artwork', 512, 500);
      ctx.font = '28px system-ui, sans-serif';
      ctx.fillText("Transparent areas show the vehicle's paint", 512, 550);
    }
  };

  // -- host helpers ----------------------------------------------------------------------
  const loadImage = async (purpose: 'artwork' | 'uv', opts: { follow?: boolean; uri?: string }) => {
    const reply = await hostRequest({ type: 'modLiveryImage', requestId: newRequestId(), purpose, ...opts }, 'modLiveryImage');
    if (reply.error) return setStatus(`Couldn't open the image: ${reply.error}`, 'bad');
    if (!reply.data || !reply.name) return;
    await useImage(purpose, reply.name, reply.data);
    if (purpose === 'artwork' && reply.linkId) {
      if (linkId) vscode.postMessage({ type: 'modLiveryUnfollow', linkId });
      linkId = reply.linkId;
    }
    render();
  };
  const useImage = async (purpose: 'artwork' | 'uv', name: string, data: Uint8Array) => {
    try {
      const img = await decodeImage(name, data);
      if (purpose === 'uv') uv = { canvas: img.canvas, name };
      else {
        artwork = { canvas: img.canvas, name };
        const { width, height } = img.canvas;
        if (width === height && isPow2(width) && SIZES.includes(width)) size = width;
      }
      draw();
    } catch (err) {
      setStatus(`Couldn't read ${name}: ${(err as Error).message}`, 'bad');
    }
  };
  onHostMessage((m) => {
    if (m.type === 'modLiveryFollowed') {
      if (m.linkId !== linkId) return;
      void useImage(m.purpose, m.name, m.data).then(() => setStatus(`Showing ${m.name}, updated ${new Date().toLocaleTimeString()}.`));
    }
  });

  /** A starting image for the image app: the UV template (or the current artwork) at the livery size. */
  const startImage = async () => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    if (artwork) ctx.drawImage(artwork.canvas, 0, 0, size, size);
    else if (uv) ctx.drawImage(uv.canvas, 0, 0, size, size);
    const png = await rgbaToPng(canvasToRgba(c), size, size);
    const name = `${updating?.modelName ?? nameInput.value ?? 'livery'}.png`;
    const reply = await hostRequest({ type: 'modLiveryEditExternally', requestId: newRequestId(), suggestedName: name, data: png }, 'modLiveryImage');
    if (!reply.data || !reply.name) return;
    await useImage('artwork', reply.name, reply.data);
    if (reply.linkId) {
      if (linkId) vscode.postMessage({ type: 'modLiveryUnfollow', linkId });
      linkId = reply.linkId;
    }
    setStatus(`Opened ${reply.name} in your image app${artwork ? '' : ' (the UV template as a starting point: hide or delete it before saving)'}. Save it there and the preview updates here.`);
    render();
  };

  const editExisting = async (l: ModLiveryVehicle['liveries'][number]) => {
    if (!l.file) return;
    const reply = await hostRequest({ type: 'modLiveryLoadExisting', requestId: newRequestId(), uri: l.file.uri }, 'modLiveryTexture');
    if (!reply.texture) return setStatus(`Couldn't open ${l.modelName}: ${reply.error}`, 'bad');
    const c = textureCanvas(reply.texture);
    artwork = { canvas: c, name: `${l.modelName} (current)` };
    if (isPow2(c.width) && c.width === c.height && SIZES.includes(c.width)) size = c.width;
    updating = { modelName: l.modelName, uri: l.file.uri };
    labelKey.value = l.label;
    if (l.text) labelText.value = l.text;
    if (linkId) vscode.postMessage({ type: 'modLiveryUnfollow', linkId });
    linkId = undefined;
    setStatus(`Editing ${l.modelName}. Follow an image or use "Edit in image app" to change it.`);
    draw();
    render();
  };

  // -- inputs that keep their state across renders ----------------------------------------
  const nameInput = h('input', { type: 'text', class: 'modlivery-name', spellcheck: false, value: vehicle?.suggestedName ?? '' });
  const labelKey = h('input', { type: 'text', class: 'modlivery-name', spellcheck: false, value: (vehicle?.suggestedName ?? '').toUpperCase() });
  const labelText = h('input', { type: 'text', class: 'modlivery-name', value: 'Custom livery' });
  nameInput.addEventListener('input', () => {
    if (!labelEdited) labelKey.value = nameInput.value.toUpperCase();
    renderChecks();
  });
  labelKey.addEventListener('input', () => ((labelEdited = true), renderChecks()));
  const checks = h('div', { class: 'small' });
  const createBtn = h('button', { class: 'chip active' }, 'Create livery');

  const nameProblem = (): string | undefined => {
    const n = nameInput.value.trim();
    if (!n) return 'Enter a model name.';
    if (!/^[a-z0-9_]+$/i.test(n)) return 'The model name may only use letters, digits and underscores.';
    if (!updating && vehicle?.liveries.some((l) => l.modelName.toLowerCase() === n.toLowerCase())) return `${vehicle.kit} already has a livery called ${n}.`;
    if (!/^[a-z0-9_]+$/i.test(labelKey.value.trim())) return 'The name key may only use letters, digits and underscores.';
    return undefined;
  };
  const renderChecks = () => {
    const problems = [
      !vehicle && 'No vehicle with a mod kit was found in the workspace.',
      !updating && !template && 'Choose a template livery model.',
      !artwork && 'Choose or follow your artwork.',
      !folder && !updating && 'Choose where the livery resource goes.',
      nameProblem(),
    ].filter((x): x is string => !!x);
    checks.replaceChildren(...problems.map((p) => h('div', { class: 'opt-bad' }, p)));
    createBtn.disabled = problems.length > 0;
    createBtn.textContent = updating ? `Update ${updating.modelName}` : 'Create livery';
  };

  const create = async () => {
    if (!vehicle || !artwork || !folder) return;
    const c = resizeCanvas(artwork.canvas, size, size);
    setStatus('Writing the livery…');
    createBtn.disabled = true;
    const reply = await hostRequest(
      {
        type: 'modLiveryCreate',
        requestId: newRequestId(),
        model: vehicle.model,
        kit: vehicle.kit,
        carcols: vehicle.carcols,
        template: template?.uri ?? '',
        ...(updating ? { update: updating.uri } : {}),
        modelName: updating?.modelName ?? nameInput.value.trim(),
        labelKey: labelKey.value.trim(),
        labelText: labelText.value.trim(),
        folder: folder.uri,
        width: size,
        height: size,
        rgba: canvasToRgba(c),
      },
      'modLiveryCreated'
    );
    renderChecks();
    if (reply.ok && !updating) justCreated = nameInput.value.trim();
    if (reply.ok) setStatus(reply.message ?? 'Done.', 'ok');
    else if (reply.error) setStatus(reply.error, 'bad');
    else setStatus('');
  };
  createBtn.addEventListener('click', () => void create());

  // -- layout -----------------------------------------------------------------------------
  const section = (title: string, ...body: (HTMLElement | null)[]) => h('div', { class: 'modlivery-section' }, h('div', { class: 'pack-section' }, title), ...body.filter((x): x is HTMLElement => !!x));

  const render = () => {
    if (!vehicles.length) {
      el.replaceChildren(
        h('h2', null, 'New mod-kit livery'),
        h('div', { class: 'warn' }, 'No carcols.meta with a mod kit was found in the workspace.'),
        h('div', { class: 'muted small' }, "Open the folder that holds the vehicle's resource (its data/carcols.meta and carvariations.meta), then run this again.")
      );
      return;
    }
    const v = vehicle!;
    const vehicleSelect = h(
      'select',
      {
        onchange: () => {
          vehicle = vehicles[Number(vehicleSelect.value)];
          folder = { uri: vehicle.defaultFolder, path: vehicle.defaultFolderPath };
          nameInput.value = vehicle.suggestedName;
          if (!labelEdited) labelKey.value = vehicle.suggestedName.toUpperCase();
          updating = undefined;
          uv = undefined;
          if (vehicle.uvTemplates[0]) void loadImage('uv', { uri: vehicle.uvTemplates[0].uri });
          render();
          draw();
        },
      },
      vehicles.map((x, i) => h('option', { value: String(i), selected: x === v }, `${x.model} — ${x.kit} (${x.liveries.length} livery mod${x.liveries.length === 1 ? '' : 's'})`))
    );
    const liveryRows = v.liveries.map((l) =>
      h(
        'div',
        { class: `modlivery-mod${updating?.modelName === l.modelName ? ' active' : ''}` },
        h('span', { class: 'muted small modlivery-index' }, String(l.index)),
        h('span', null, l.modelName),
        h('span', { class: 'muted small' }, ` ${l.label}`),
        h('span', { class: 'spacer' }),
        l.file
          ? l.file.encrypted
            ? h('span', { class: 'muted small', title: l.file.path }, 'escrow-protected')
            : h('button', { class: 'chip mini', title: `Replace the artwork of ${l.file.path}`, onclick: () => void editExisting(l) }, 'Edit')
          : h('span', { class: 'muted small', title: 'No model with this name in the workspace (it may come from another resource)' }, 'not here')
      )
    );

    const templateSelect = h(
      'select',
      {
        onchange: async () => {
          if (templateSelect.value === 'browse') {
            const reply = await hostRequest({ type: 'modLiveryPickTemplate', requestId: newRequestId() }, 'modLiveryTemplatePicked');
            if (reply.template) {
              if (reply.template.texture) {
                templates.push(reply.template);
                template = reply.template;
              } else setStatus(`${reply.template.path} can't be used as a template: ${reply.template.error}.`, 'bad');
            }
          } else template = templates[Number(templateSelect.value)];
          render();
        },
      },
      templates.map((t, i) => h('option', { value: String(i), selected: t === template }, t.path)),
      h('option', { value: 'browse' }, 'Browse…'),
      templates.length ? null : h('option', { value: '', selected: true, disabled: true }, '— choose a template —')
    );

    const uvSelect = h(
      'select',
      {
        onchange: () => {
          if (uvSelect.value === 'browse') void loadImage('uv', {});
          else if (uvSelect.value === 'none') ((uv = undefined), draw(), render());
          else void loadImage('uv', { uri: uvSelect.value });
        },
      },
      h('option', { value: 'none', selected: !uv }, 'None'),
      v.uvTemplates.map((t) => h('option', { value: t.uri, selected: uv?.name === t.path.split('/').pop() }, t.path)),
      h('option', { value: 'browse', selected: !!uv && !v.uvTemplates.some((t) => t.path.endsWith(uv!.name)) }, uv && !v.uvTemplates.some((t) => t.path.endsWith(uv!.name)) ? uv.name : 'Browse…')
    );
    const uvModeSelect = h(
      'select',
      { onchange: () => ((uvMode = uvModeSelect.value as typeof uvMode), setPref('modLivery:uvMode', uvMode), draw()) },
      h('option', { value: 'over', selected: uvMode === 'over' }, 'over the artwork'),
      h('option', { value: 'under', selected: uvMode === 'under' }, 'under the artwork'),
      h('option', { value: 'off', selected: uvMode === 'off' }, 'hidden')
    );
    const uvOpacityInput = h('input', { type: 'range', min: 5, max: 100, value: uvOpacity });
    uvOpacityInput.addEventListener('input', () => ((uvOpacity = Number(uvOpacityInput.value)), setPref('modLivery:uvOpacity', uvOpacity), draw()));
    const sizeSelect = h(
      'select',
      { onchange: () => ((size = Number(sizeSelect.value)), setPref('modLivery:size', size)) },
      SIZES.map((n) => h('option', { value: String(n), selected: n === size }, `${n}×${n}`))
    );

    el.replaceChildren(
      h('h2', null, 'New mod-kit livery'),
      h(
        'div',
        { class: 'muted small' },
        "For vehicles whose liveries are separate models (VMT_LIVERY_MOD in carcols.meta), including escrow-protected packs: your artwork goes into a copy of the creator's template livery model, which is added to the vehicle's kit and streamed from a resource of its own."
      ),
      h(
        'div',
        { class: 'modlivery-layout' },
        h(
          'div',
          { class: 'modlivery-form' },
          section(
            'Vehicle',
            vehicleSelect,
            h('div', { class: 'muted small' }, `Kit ${v.kit}${v.kitId !== undefined ? ` (id ${v.kitId})` : ''} in ${v.carcolsPath}`),
            v.carcolsLoaded ? null : h('div', { class: 'warn small' }, "No fxmanifest.lua in the workspace loads this carcols.meta (CARCOLS_FILE), so the game may not see changes to it."),
            v.escrowed ? h('div', { class: 'muted small' }, 'The vehicle model is escrow-protected, so the livery is previewed flat, over its UV template.') : null,
            v.liveries.length ? h('div', { class: 'modlivery-mods' }, liveryRows) : h('div', { class: 'muted small' }, 'This kit has no livery mods yet; the first one gets mod index 0.'),
            updating ? h('div', { class: 'row' }, h('span', { class: 'small' }, `Updating ${updating.modelName}`), h('button', {
                  class: 'chip mini',
                  onclick: () => {
                    updating = undefined;
                    nameInput.value = v.suggestedName;
                    labelKey.value = v.suggestedName.toUpperCase();
                    labelEdited = false;
                    render();
                  },
                }, 'Make a new one instead')) : null
          ),
          updating
            ? null
            : section(
                'Template',
                templateSelect,
                template?.texture
                  ? h('div', { class: 'muted small' }, `Livery texture "${template.texture}" (${template.size}); it's replaced by your artwork at the size below.`)
                  : h('div', { class: 'muted small' }, "Use the blank livery model the vehicle's creator provides (for ONX packs: onx_polname_liv_blank.yft from their livery templates)."),
              ),
          section(
            'Artwork',
            h(
              'div',
              { class: 'row' },
              h('button', { class: 'chip', title: 'Use an image file once', onclick: () => void loadImage('artwork', {}) }, 'Choose image…'),
              h('button', { class: 'chip', title: 'Use an image file and update whenever you save it', onclick: () => void loadImage('artwork', { follow: true }) }, 'Follow image…'),
              h('button', { class: 'chip', title: 'Save a PNG to paint on (the UV template, or the current artwork), open it in your image app and follow it', disabled: !uv && !artwork, onclick: () => void startImage() }, 'Edit in image app')
            ),
            artwork ? h('div', { class: 'small' }, `${linkId ? '⟳ Following ' : ''}${artwork.name} (${artwork.canvas.width}×${artwork.canvas.height})`) : null,
            h('div', { class: 'row' }, h('span', { class: 'label' }, 'Size'), sizeSelect),
            h('div', { class: 'row' }, h('span', { class: 'label' }, 'UV template'), uvSelect),
            uv ? h('div', { class: 'row' }, uvModeSelect, uvOpacityInput) : null
          ),
          section(
            'Name',
            updating ? h('div', { class: 'small' }, updating.modelName) : h('label', { class: 'modlivery-field' }, h('span', null, 'Model name'), nameInput),
            h('label', { class: 'modlivery-field' }, h('span', null, 'Name in game'), labelText),
            h('label', { class: 'modlivery-field', title: 'The text label (modShopLabel) the mod shop looks up; set by AddTextEntry in the livery resource' }, h('span', null, 'Name key'), labelKey)
          ),
          updating
            ? null
            : section(
                'Save to',
                h('div', { class: 'row' }, h('span', { class: 'small' }, folder?.path ?? '—'), h('button', {
                  class: 'chip mini',
                  onclick: async () => {
                    const reply = await hostRequest({ type: 'modLiveryPickFolder', requestId: newRequestId() }, 'modLiveryFolder');
                    if (reply.uri && reply.path) ((folder = { uri: reply.uri, path: reply.path }), render());
                  },
                }, 'Change…')),
                h('div', { class: 'muted small' }, 'A resource of its own (fxmanifest.lua, stream/<name>.yft, liveries.lua for the in-game name). The vehicle pack itself is only changed in its carcols.meta.')
              ),
          h('div', { class: 'row' }, createBtn),
          checks,
          status
        ),
        h('div', { class: 'modlivery-side' }, preview, h('div', { class: 'muted small' }, 'Flat preview of the livery texture. Transparent areas show the paint colour.'))
      )
    );
    renderChecks();
  };

  render();
  draw();
  if (vehicle?.uvTemplates[0]) void loadImage('uv', { uri: vehicle.uvTemplates[0].uri });
  return {
    el,
    update(nextVehicles, nextTemplates, next) {
      const key = vehicle && `${vehicle.model}|${vehicle.kit}`;
      vehicles = nextVehicles;
      templates.splice(0, templates.length, ...nextTemplates.filter((t) => !templates.some((x) => x.uri === t.uri)), ...templates);
      vehicle = vehicles.find((v) => `${v.model}|${v.kit}` === key) ?? vehicles.find((v) => v.model === next) ?? vehicles[0];
      if (template && !templates.includes(template)) template = templates[0];
      // A livery just written is now in the kit: keep working on it (Update), with its own name key.
      const created = justCreated && vehicle?.liveries.find((x) => x.modelName === justCreated && x.file && !x.file.encrypted);
      justCreated = undefined;
      if (created && created.file) updating = { modelName: created.modelName, uri: created.file.uri };
      const current = updating && vehicle?.liveries.find((x) => x.modelName === updating!.modelName);
      if (current?.file) {
        updating = { modelName: current.modelName, uri: current.file.uri };
        labelKey.value = current.label;
        if (current.text) labelText.value = current.text;
      } else if (vehicle) {
        nameInput.value = vehicle.suggestedName;
        if (!labelEdited) labelKey.value = vehicle.suggestedName.toUpperCase();
      }
      render();
    },
  };
}
