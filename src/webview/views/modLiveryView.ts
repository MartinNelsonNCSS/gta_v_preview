import type { ModLiveryTemplate, ModLiveryVehicle } from '../../shared/model';
import { Designer, bytesToDataUrl } from '../design/designer';
import { emptyDesign, parseDesign } from '../design/model';
import { canvasToRgba, decodeImage, rgbaToPng } from '../imageUtils';
import { textureCanvas } from '../textureCanvas';
import { h, hostRequest, newRequestId, onHostMessage, pref, setPref, vscode } from '../ui';

/*
 * Mod-kit livery maker: the vehicle's kit, a template livery model, the
 * livery itself (designed in the vector designer over the vehicle's UV
 * template), a name, and where the new livery resource goes.
 */

const SIZES = [512, 1024, 2048, 4096];

export interface ModLiveryView {
  el: HTMLElement;
  /** New workspace data (e.g. after a livery was written); keeps the design and messages. */
  update(vehicles: ModLiveryVehicle[], templates: ModLiveryTemplate[], preselect?: string): void;
}

export function modLiveryView(vehicles: ModLiveryVehicle[], templates: ModLiveryTemplate[], preselect?: string, draft?: string): ModLiveryView {
  let vehicle = vehicles.find((v) => v.model === preselect || v.liveries.some((l) => l.modelName.toLowerCase() === preselect)) ?? vehicles[0];
  let template: ModLiveryTemplate | undefined = templates[0];
  let uv: { name: string } | undefined;
  /** Existing livery model being updated (instead of adding a new one). */
  let updating: { modelName: string; uri: string } | undefined;
  let size = pref('modLivery:size', 2048);
  let labelEdited = false;
  let settingsOpen = true;
  /** A livery just created: switch to updating it once the workspace data includes it. */
  let justCreated: string | undefined;
  let folder = vehicle ? { uri: vehicle.defaultFolder, path: vehicle.defaultFolderPath } : undefined;

  const el = h('div', { class: 'modlivery' });
  const status = h('div', { class: 'modlivery-status small' });
  const setStatus = (text: string, kind: 'ok' | 'bad' | '' = '') => {
    status.textContent = text;
    status.className = `modlivery-status small${kind ? ` opt-${kind}` : ''}`;
  };

  // -- designer -----------------------------------------------------------------------------
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  const designer = new Designer({
    pickImage: async (follow) => {
      const reply = await hostRequest({ type: 'modLiveryImage', requestId: newRequestId(), purpose: 'artwork', follow }, 'modLiveryImage');
      if (reply.error) setStatus(`Couldn't open the image: ${reply.error}`, 'bad');
      return reply.data && reply.name ? { name: reply.name, data: reply.data, ...(reply.linkId ? { linkId: reply.linkId } : {}) } : undefined;
    },
    listFonts: async () => (await hostRequest({ type: 'listFonts', requestId: newRequestId() }, 'fontList')).families,
    pickFont: async () => {
      const reply = await hostRequest({ type: 'modLiveryPickFont', requestId: newRequestId() }, 'modLiveryFont');
      return reply.data && reply.name ? { name: reply.name, data: reply.data } : undefined;
    },
    changed: () => {
      renderChecks();
      // Keep a draft, so closing the panel doesn't lose the work.
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => vscode.postMessage({ type: 'modLiveryDraft', text: JSON.stringify(designer.design) }), 1500);
    },
    status: (text) => setStatus(text),
  });

  const loadTemplateImage = async (opts: { uri?: string }) => {
    const reply = await hostRequest({ type: 'modLiveryImage', requestId: newRequestId(), purpose: 'uv', ...opts }, 'modLiveryImage');
    if (reply.error) return setStatus(`Couldn't open the UV template: ${reply.error}`, 'bad');
    if (!reply.data || !reply.name) return;
    try {
      const img = await decodeImage(reply.name, reply.data);
      uv = { name: reply.name };
      designer.setTemplate(img.canvas);
    } catch (err) {
      setStatus(`Couldn't read ${reply.name}: ${(err as Error).message}`, 'bad');
    }
    render();
  };

  onHostMessage((m) => {
    if (m.type === 'modLiveryFollowed') {
      void bytesToDataUrl(m.name, m.data).then((url) => designer.updateFollowed(m.linkId, m.name, url));
    }
  });

  let editToken = 0;
  const editExisting = async (l: ModLiveryVehicle['liveries'][number]) => {
    if (!l.file) return;
    // A later Edit click wins over one still loading.
    const token = ++editToken;
    setStatus(`Opening ${l.modelName}…`);
    const reply = await hostRequest({ type: 'modLiveryLoadExisting', requestId: newRequestId(), uri: l.file.uri }, 'modLiveryTexture');
    if (token !== editToken) return;
    if (!reply.texture) return setStatus(`Couldn't open ${l.modelName}: ${reply.error}`, 'bad');
    updating = { modelName: l.modelName, uri: l.file.uri };
    labelKey.value = l.label;
    if (l.text) labelText.value = l.text;
    if (SIZES.includes(reply.texture.width) && reply.texture.width === reply.texture.height) size = reply.texture.width;
    if (reply.design) {
      const design = parseDesign(reply.design);
      if (token !== editToken) return;
      await designer.load(design);
      setStatus(`Editing ${l.modelName} from its saved design.`);
    } else {
      // No saved design: the livery's current pixels become a locked bottom layer to build on.
      const current = textureCanvas(reply.texture);
      await designer.load(emptyDesign());
      if (token !== editToken) return;
      await designer.addImage(`${l.modelName} (current)`, current, { fill: true, locked: true, bottom: true });
      setStatus(`Editing ${l.modelName}. Its current texture is the bottom layer (locked); add layers on top.`);
    }
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
      designer.isEmpty && 'Design the livery on the canvas (or add an image layer).',
      !folder && !updating && 'Choose where the livery resource goes.',
      nameProblem(),
    ].filter((x): x is string => !!x);
    checks.replaceChildren(...problems.map((p) => h('div', { class: 'opt-bad' }, p)));
    createBtn.disabled = problems.length > 0;
    createBtn.textContent = updating ? `Update ${updating.modelName}` : 'Create livery';
  };

  const create = async () => {
    if (!vehicle || !folder) return;
    const c = designer.rasterize(size);
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
        design: JSON.stringify(designer.design),
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

  const exportPng = async () => {
    const c = designer.rasterize(size);
    const png = await rgbaToPng(canvasToRgba(c), size, size);
    const reply = await hostRequest({ type: 'modLiverySaveFile', requestId: newRequestId(), suggestedName: `${updating?.modelName ?? nameInput.value.trim() ?? 'livery'}.png`, data: png, kind: 'png' }, 'modLiverySaved');
    if (reply.path) setStatus(`Saved ${reply.path}.`, 'ok');
  };
  const saveDesign = async () => {
    const data = new TextEncoder().encode(JSON.stringify(designer.design, null, 1));
    const reply = await hostRequest({ type: 'modLiverySaveFile', requestId: newRequestId(), suggestedName: `${updating?.modelName ?? nameInput.value.trim() ?? 'livery'}.livery.json`, data, kind: 'design' }, 'modLiverySaved');
    if (reply.path) setStatus(`Saved the design to ${reply.path}.`, 'ok');
  };
  const openDesign = async () => {
    const reply = await hostRequest({ type: 'modLiveryOpenDesign', requestId: newRequestId() }, 'modLiveryDesign');
    if (reply.error) return setStatus(`Couldn't open the design: ${reply.error}`, 'bad');
    if (!reply.text) return;
    try {
      await designer.load(parseDesign(reply.text));
      setStatus(`Opened ${reply.name}.`);
      renderChecks();
    } catch (err) {
      setStatus(`Couldn't open ${reply.name}: ${(err as Error).message}`, 'bad');
    }
  };

  // -- layout -----------------------------------------------------------------------------
  const section = (title: string, ...body: (HTMLElement | null)[]) => h('div', { class: 'modlivery-section' }, h('div', { class: 'pack-section' }, title), ...body.filter((x): x is HTMLElement => !!x));
  const form = h('div', { class: 'modlivery-form' });
  const toggle = h('button', { class: 'chip mini modlivery-toggle', title: 'Show or hide the livery settings', onclick: () => ((settingsOpen = !settingsOpen), render()) });

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
          designer.setTemplate(undefined);
          if (vehicle.uvTemplates[0]) void loadTemplateImage({ uri: vehicle.uvTemplates[0].uri });
          render();
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
            : h('button', { class: 'chip mini', title: `Edit the design of ${l.file.path}`, onclick: () => void editExisting(l) }, 'Edit')
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

    const customUv = !!uv && !v.uvTemplates.some((t) => t.path.endsWith(uv!.name));
    const uvSelect = h(
      'select',
      {
        onchange: () => {
          if (uvSelect.value === 'browse') void loadTemplateImage({});
          else if (uvSelect.value === 'none') ((uv = undefined), designer.setTemplate(undefined), render());
          else void loadTemplateImage({ uri: uvSelect.value });
        },
      },
      h('option', { value: 'none', selected: !uv }, 'None'),
      v.uvTemplates.map((t) => h('option', { value: t.uri, selected: !!uv && t.path.endsWith(uv.name) }, t.path)),
      h('option', { value: 'browse', selected: customUv }, customUv ? uv!.name : 'Browse…')
    );
    const sizeSelect = h(
      'select',
      { onchange: () => ((size = Number(sizeSelect.value)), setPref('modLivery:size', size)) },
      SIZES.map((n) => h('option', { value: String(n), selected: n === size }, `${n}×${n}`))
    );

    const formParts: (HTMLElement | null)[] = [
      section(
        'Vehicle',
        vehicleSelect,
        h('div', { class: 'muted small' }, `Kit ${v.kit}${v.kitId !== undefined ? ` (id ${v.kitId})` : ''} in ${v.carcolsPath}`),
        v.carcolsLoaded ? null : h('div', { class: 'warn small' }, 'No fxmanifest.lua in the workspace loads this carcols.meta (CARCOLS_FILE), so the game may not see changes to it.'),
        v.liveries.length ? h('div', { class: 'modlivery-mods' }, liveryRows) : h('div', { class: 'muted small' }, 'This kit has no livery mods yet; the first one gets mod index 0.'),
        updating
          ? h(
              'div',
              { class: 'row' },
              h('span', { class: 'small' }, `Updating ${updating.modelName}`),
              h(
                'button',
                {
                  class: 'chip mini',
                  onclick: () => {
                    updating = undefined;
                    nameInput.value = v.suggestedName;
                    labelKey.value = v.suggestedName.toUpperCase();
                    labelEdited = false;
                    render();
                  },
                },
                'Make a new one instead'
              )
            )
          : null
      ),
      updating
        ? null
        : section(
            'Template',
            templateSelect,
            template?.texture
              ? h('div', { class: 'muted small' }, `Livery texture "${template.texture}" (${template.size}); replaced by your design at the size below.`)
              : h('div', { class: 'muted small' }, "Use the blank livery model the vehicle's creator provides (for ONX packs: onx_polname_liv_blank.yft from their livery templates).")
          ),
      section(
        'Texture',
        h('div', { class: 'row' }, h('span', { class: 'label' }, 'Size'), sizeSelect),
        h('div', { class: 'row' }, h('span', { class: 'label' }, 'UV template'), uvSelect),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'chip mini', title: 'Open a saved .livery.json design', onclick: () => void openDesign() }, 'Open design…'),
          h('button', { class: 'chip mini', title: 'Save the design (editable layers) as .livery.json', onclick: () => void saveDesign() }, 'Save design…'),
          h('button', { class: 'chip mini', title: 'Save the livery as a flat PNG at the size above', onclick: () => void exportPng() }, 'Export PNG…')
        )
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
            h(
              'div',
              { class: 'row' },
              h('span', { class: 'small' }, folder?.path ?? '—'),
              h(
                'button',
                {
                  class: 'chip mini',
                  onclick: async () => {
                    const reply = await hostRequest({ type: 'modLiveryPickFolder', requestId: newRequestId() }, 'modLiveryFolder');
                    if (reply.uri && reply.path) ((folder = { uri: reply.uri, path: reply.path }), render());
                  },
                },
                'Change…'
              )
            ),
            h('div', { class: 'muted small' }, 'A resource of its own (fxmanifest.lua, stream/<name>.yft, liveries.lua for the in-game name; the design is kept in designs/). The vehicle pack itself is only changed in its carcols.meta.')
          ),
      h('div', { class: 'row' }, createBtn),
      checks,
      status,
    ];
    form.replaceChildren(...formParts.filter((x): x is HTMLElement => !!x));
    toggle.textContent = settingsOpen ? '◀ Settings' : '▶ Settings';
    form.style.display = settingsOpen ? '' : 'none';
    if (!el.firstChild) {
      el.replaceChildren(
        h('div', { class: 'modlivery-header' }, toggle, h('h2', null, 'Mod-kit livery'), h('span', { class: 'muted small' }, 'For vehicles whose liveries are separate models (VMT_LIVERY_MOD), including escrow-protected packs.')),
        h('div', { class: 'modlivery-layout' }, form, designer.el)
      );
    }
    renderChecks();
  };

  render();
  if (vehicle?.uvTemplates[0]) void loadTemplateImage({ uri: vehicle.uvTemplates[0].uri });
  if (draft) {
    try {
      void designer.load(parseDesign(draft)).then(() => {
        if (!designer.isEmpty) setStatus('Restored your unsaved design from last time.');
        renderChecks();
      });
    } catch {
      // A broken draft is just dropped.
    }
  }
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
