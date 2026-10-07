import * as THREE from 'three';
import type { AnimationInfo, AnimTarget, ClipDictionaryData } from '../../shared/model';
import { isPedAnimation, pedBoneName } from '../../formats/pedSkeleton';
import { animatedBones, clipLength, ModelRig, PedRig, Rig, samplePose, trackName } from '../animation';
import { availableLod, TextureStore } from '../scene';
import { checkbox, fmt, h, pref, setPref } from '../ui';
import { Viewer } from '../viewer';
import { fetchTextures, kv, renderOptions, section } from './modelPanel';

const SPEEDS = [0.1, 0.25, 0.5, 1, 2];

/** How a clip is shown: on the built-in ped, on a nearby model, or as a moving root marker. */
type RigChoice = { kind: 'ped' } | { kind: 'model'; target: AnimTarget } | { kind: 'root' };

/** A marker for animations that only move an object's root (or whose model isn't available). */
class RootRig implements Rig {
  readonly object = new THREE.Group();
  readonly tags = new Set<number>([0]);
  private readonly node = new THREE.Group();
  constructor() {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x4f8fdb, transparent: true, opacity: 0.5 }));
    box.position.z = 0.25;
    this.node.add(box, new THREE.AxesHelper(0.6));
    this.object.add(this.node);
  }
  apply(pose: ReturnType<typeof samplePose>, rootMotion: boolean): void {
    const p = pose.position.get(0) ?? new THREE.Vector3();
    const q = pose.rotation.get(0) ?? new THREE.Quaternion();
    const mp = rootMotion && pose.moverPosition ? pose.moverPosition : new THREE.Vector3();
    const mq = rootMotion && pose.moverRotation ? pose.moverRotation : new THREE.Quaternion();
    this.node.position.copy(p.clone().applyQuaternion(mq).add(mp));
    this.node.quaternion.copy(mq.clone().multiply(q));
  }
}

/** Preview for .ycd clip dictionaries: pick a clip, play/scrub it on a skeleton or model. */
export function ycdView(file: string, ycd: ClipDictionaryData, targets: AnimTarget[], targetNotes: string[]): HTMLElement {
  const status = h('div', { class: 'status' });
  const stage = h('div', { class: 'stage' }, status);
  const sidebar = h('div', { class: 'sidebar' });
  const toolbar = h('div', { class: 'toolbar' });
  const transport = h('div', { class: 'toolbar anim-transport' });
  const root = h('div', { class: 'model-panel' }, toolbar, h('div', { class: 'model-body' }, h('div', { class: 'anim-stage' }, stage, transport), sidebar));
  const viewer = new Viewer(stage);
  viewer.setGridVisible(pref('grid', true));
  const store = new TextureStore();
  const opts = renderOptions();
  for (const t of targets) store.add(t.drawable.textures, 'embedded');
  const texturesFetched = new Set<AnimTarget>();

  if (!ycd.clips.length) {
    status.textContent = 'This clip dictionary is empty.';
    return root;
  }

  let clipIndex = Math.min(pref('ycdClip', 0), ycd.clips.length - 1);
  let rig: Rig | undefined;
  let choice: RigChoice = { kind: 'root' };
  let userChoice: RigChoice | undefined;
  let time = 0;
  let playing = true;
  let speed = pref('ycdSpeed', 1);
  let loop = pref('ycdLoop', true);
  let rootMotion = pref('ycdRootMotion', false);
  let last = 0;

  const clip = () => ycd.clips[clipIndex];
  const anim = (): AnimationInfo | undefined => ycd.animations[clip().animation];
  const length = () => (anim() ? clipLength(clip(), anim()!) : 0);

  /** Rig options for a clip, best first. */
  const choicesFor = (a: AnimationInfo | undefined): RigChoice[] => {
    const out: RigChoice[] = [];
    const tags = a ? animatedBones(a) : new Set<number>();
    if (tags.size && isPedAnimation(tags)) out.push({ kind: 'ped' });
    const coverage = (t: AnimTarget) => {
      const have = new Set(t.drawable.bones.map((b) => b.tag));
      return [...tags].filter((x) => have.has(x)).length;
    };
    const models = targets.filter((t) => coverage(t) > 0).sort((x, y) => coverage(y) - coverage(x));
    out.push(...models.map((target) => ({ kind: 'model' as const, target })));
    if (!out.length || !tags.size) out.push({ kind: 'root' });
    if (!out.some((c) => c.kind === 'ped')) out.push({ kind: 'ped' });
    if (!out.some((c) => c.kind === 'root')) out.push({ kind: 'root' });
    return out;
  };
  const choiceLabel = (c: RigChoice) => (c.kind === 'ped' ? 'Ped skeleton' : c.kind === 'model' ? `${c.target.file}${c.target.drawable.name && !c.target.file.startsWith(c.target.drawable.name) ? ` (${c.target.drawable.name})` : ''}` : 'Object root');

  // --- transport -------------------------------------------------------------
  const playButton = h('button', { class: 'chip', title: 'Play / pause (space)' });
  const scrub = h('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'anim-scrub' });
  const timeLabel = h('span', { class: 'anim-time' });
  const updatePlayButton = () => (playButton.textContent = playing ? '❚❚ Pause' : '▶ Play');
  playButton.onclick = () => togglePlay();
  scrub.addEventListener('input', () => {
    time = (Number(scrub.value) / 1000) * length();
    if (playing) togglePlay();
    render();
  });
  const speedSelect = h(
    'select',
    { onchange: () => ((speed = Number(speedSelect.value)), setPref('ycdSpeed', speed)), title: 'Playback speed' },
    SPEEDS.map((s) => h('option', { value: String(s), selected: s === speed }, `${s}×`))
  );
  const step = (frames: number) => {
    const a = anim();
    if (!a || a.frames < 2) return;
    if (playing) togglePlay();
    const dt = a.duration / (a.frames - 1);
    time = Math.min(length(), Math.max(0, Math.round(time / dt + frames) * dt));
    render();
  };
  transport.append(
    playButton,
    h('button', { class: 'chip', title: 'Previous frame', onclick: () => step(-1) }, '◀'),
    h('button', { class: 'chip', title: 'Next frame', onclick: () => step(1) }, '▶'),
    scrub,
    timeLabel,
    speedSelect
  );

  const togglePlay = () => {
    playing = !playing;
    if (playing && time >= length() - 1e-4) time = 0;
    updatePlayButton();
    if (playing) {
      last = performance.now();
      requestAnimationFrame(tick);
    }
  };
  const tick = (now: number) => {
    if (!playing || !root.isConnected) return;
    const len = length();
    time += ((now - last) / 1000) * speed;
    last = now;
    if (time > len) {
      if (loop && len > 0) time %= len;
      else {
        time = len;
        playing = false;
        updatePlayButton();
      }
    }
    render();
    if (playing) requestAnimationFrame(tick);
  };
  root.tabIndex = 0;
  root.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'SELECT' || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === ' ') (e.preventDefault(), togglePlay());
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  /** Poses the rig at the current time and redraws. */
  const render = () => {
    const a = anim();
    const len = length();
    if (a && rig) rig.apply(samplePose(a, clip(), time), rootMotion);
    scrub.value = String(len > 0 ? Math.round((time / len) * 1000) : 0);
    const frame = a && a.duration > 0 ? Math.round(((clip().start + time) / a.duration) * (a.frames - 1)) : 0;
    timeLabel.textContent = `${time.toFixed(2)} / ${len.toFixed(2)} s · frame ${frame}`;
    viewer.requestRender();
  };

  // --- rig -------------------------------------------------------------------
  const rigSelect = h('select', { title: 'What to play the animation on' });
  const setRig = (c: RigChoice, reframe: boolean) => {
    choice = c;
    if (c.kind === 'ped') rig = new PedRig();
    else if (c.kind === 'model') {
      const d = c.target.drawable;
      rig = new ModelRig(d, availableLod(d, 'high'), store, opts);
      if (!texturesFetched.has(c.target)) {
        texturesFetched.add(c.target);
        const names = d.shaders.flatMap((s) => s.textures.map((t) => t.texture));
        void fetchTextures(store, names, [d.name], (s) => (status.textContent = s));
      }
    } else rig = new RootRig();
    viewer.setContent(rig.object);
    // Peds face +Y: look at them from the front.
    if (c.kind === 'ped') viewer.setViewDirection(0.9, 1.6, 0.5);
    else viewer.setViewDirection(0.9, -1.4, 0.8);
    // Frame the rest pose so the camera doesn't chase root motion.
    if (reframe) {
      rig.apply({ position: new Map(), rotation: new Map() }, false);
      const a = anim();
      if (a) rig.apply(samplePose(a, clip(), 0), false);
      viewer.frame();
    }
    render();
    renderSidebar();
  };

  // --- clip selection --------------------------------------------------------
  const clipSelect = h(
    'select',
    {
      onchange: () => {
        clipIndex = Number(clipSelect.value);
        setPref('ycdClip', clipIndex);
        selectClip();
      },
    },
    ycd.clips.map((c, i) => h('option', { value: String(i), selected: i === clipIndex }, c.name))
  );
  const selectClip = () => {
    time = 0;
    const choices = choicesFor(anim());
    rigSelect.replaceChildren(...choices.map((c, i) => h('option', { value: String(i) }, choiceLabel(c))));
    rigSelect.onchange = () => {
      userChoice = choices[Number(rigSelect.value)];
      setRig(userChoice, true);
    };
    // Keep what the user picked when it still fits this clip as well as the default does.
    const u = userChoice;
    const keep = u ? choices.findIndex((c) => c.kind === u.kind && (c.kind !== 'model' || (u.kind === 'model' && c.target === u.target))) : -1;
    const index = keep >= 0 && choices[keep].kind === choices[0].kind ? keep : 0;
    rigSelect.value = String(index);
    setRig(choices[index], true);
    status.textContent = anim() ? '' : 'This clip has no animation data.';
  };

  toolbar.append(
    h('strong', null, file),
    h('span', { class: 'sep' }),
    ycd.clips.length > 1 ? h('label', { class: 'toggle' }, 'Clip', clipSelect) : h('span', null, clip().name),
    h('label', { class: 'toggle' }, 'On', rigSelect),
    checkbox('Loop', 'ycdLoop', true, (v) => (loop = v)),
    checkbox('Root motion', 'ycdRootMotion', false, (v) => ((rootMotion = v), render())),
    checkbox('Grid', 'grid', true, (v) => viewer.setGridVisible(v)),
    h('span', { class: 'spacer' }),
    h('button', { class: 'chip', onclick: () => viewer.frame() }, 'Frame')
  );

  // --- sidebar ---------------------------------------------------------------
  const renderSidebar = () => {
    const c = clip();
    const a = anim();
    const tags = a ? animatedBones(a) : new Set<number>();
    const bones = choice.kind === 'model' ? new Map(choice.target.drawable.bones.map((b) => [b.tag, b.name])) : undefined;
    const boneName = (tag: number) => (tag === 0 ? 'root' : bones?.get(tag) ?? pedBoneName(tag) ?? `bone ${tag}`);
    const byTrack = new Map<number, number>();
    for (const t of a?.tracks ?? []) byTrack.set(t.track, (byTrack.get(t.track) ?? 0) + 1);
    const missing = rig ? [...tags].filter((t) => !rig!.tags.has(t)) : [];

    const target =
      choice.kind === 'ped'
        ? h('div', { class: 'muted' }, 'Built-in GTA V ped skeleton (body and fingers). Facial and helper bones aren’t drawn.')
        : choice.kind === 'model'
          ? h('div', { class: 'muted' }, `Parts of ${choice.target.file} follow their bones. Skinned meshes stay in their rest pose.`)
          : h(
              'div',
              { class: 'muted' },
              tags.size
                ? 'No model with these bones was found next to this file, so only the root movement is shown. Put the model (.ydr/.yft) in the same folder, or name the file va_<model>.ycd.'
                : a?.tracks.some((t) => t.boneId === 0 && [0, 1, 5, 6].includes(t.track))
                  ? 'This clip only moves the object’s root.'
                  : `This clip doesn’t move any bones; it animates other properties (${[...byTrack.keys()].map(trackName).join(', ')}).`
            );

    const sections: (HTMLElement | null)[] = [
      section(
        'Clip',
        true,
        kv('Name', c.name),
        kv('Length', `${fmt(length())} s`),
        kv('Range', `${fmt(c.start)} – ${fmt(c.end)} s`),
        ...(c.rate !== 1 ? [kv('Rate', fmt(c.rate, 3))] : []),
        ...(a ? [kv('Frames', String(a.frames)), kv('Animation', `${fmt(a.duration)} s, ${a.tracks.length} tracks`)] : []),
        ...(ycd.clips.length > 1 ? [kv('Dictionary', `${ycd.clips.length} clips, ${ycd.animations.length} animations`)] : [])
      ),
      section(
        'Preview',
        true,
        target,
        ...(choice.kind === 'root' && tags.size ? targetNotes.map((n) => h('div', { class: 'muted' }, n)) : []),
        missing.length && choice.kind !== 'root'
          ? h(
              'div',
              { class: 'muted' },
              choice.kind === 'ped'
                ? `${missing.length} other animated bone${missing.length === 1 ? '' : 's'} (face, helpers) not drawn.`
                : `${missing.length} animated bone${missing.length === 1 ? ' isn’t' : 's aren’t'} in this model’s skeleton.`
            )
          : null
      ),
      section('Tracks', true, ...[...byTrack].sort((x, y) => x[0] - y[0]).map(([t, n]) => kv(trackName(t), String(n)))),
      c.tags.length
        ? section(
            `Events (${c.tags.length})`,
            false,
            ...c.tags.map((t) => kv(t.name, t.end > t.start ? `${fmt(t.start * length())} – ${fmt(t.end * length())} s` : `${fmt(t.start * length())} s`))
          )
        : null,
      c.properties.length ? section('Properties', false, ...c.properties.map((p) => h('div', null, p))) : null,
      tags.size
        ? section(
            `Animated bones (${tags.size})`,
            false,
            h('div', { class: 'bones' }, [...tags].sort((x, y) => boneName(x).localeCompare(boneName(y))).map((t) => h('div', { class: rig?.tags.has(t) ? '' : 'muted' }, boneName(t), h('span', { class: 'muted' }, ` ${t}`))))
          )
        : null,
    ];
    sidebar.replaceChildren(...sections.filter((x): x is HTMLElement => !!x));
  };

  updatePlayButton();
  selectClip();
  if (playing) {
    last = performance.now();
    requestAnimationFrame(tick);
  }
  return root;
}
