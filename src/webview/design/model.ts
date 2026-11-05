/*
 * Vector livery designs: layers of shapes, paths, brush strokes, text and
 * images on a square canvas, kept editable and only turned into pixels when
 * the livery is written. Coordinates are in design units (DESIGN_SIZE across),
 * whatever size the texture is exported at.
 */

export const DESIGN_SIZE = 2048;

/** A colour as #rrggbb or #rrggbbaa. */
export type Colour = string;

export interface GradientStop {
  at: number;
  colour: Colour;
}

export type Paint =
  | { kind: 'none' }
  | { kind: 'solid'; colour: Colour }
  | { kind: 'linear'; stops: GradientStop[]; angle: number }
  | { kind: 'radial'; stops: GradientStop[] }
  /** Two-colour squares (e.g. Battenburg markings), `cell` units wide. */
  | { kind: 'checker'; a: Colour; b: Colour; cell: number; angle: number }
  /** Two-colour bands, `width` units each. */
  | { kind: 'stripes'; a: Colour; b: Colour; width: number; angle: number };

export interface Stroke {
  paint: Paint;
  width: number;
  join: CanvasLineJoin;
  cap: CanvasLineCap;
  /** Dash length (0: solid line). */
  dash: number;
  /** Draw the outline behind the fill (keeps thin text legible with thick outlines). */
  behind: boolean;
}

export interface Shadow {
  colour: Colour;
  blur: number;
  dx: number;
  dy: number;
}

export type Blend = 'source-over' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'soft-light' | 'hard-light' | 'difference';

export interface PathPoint {
  x: number;
  y: number;
  /** Bézier handles, relative to the point. */
  in?: { x: number; y: number };
  out?: { x: number; y: number };
}

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: Blend;
  /** Only draw where the layer below is (a clipping mask). */
  clip: boolean;
  /** Group id: grouped layers are selected, moved and transformed together. */
  group?: string;
  /** Position of the layer's centre, rotation in degrees, scale (negative: mirrored). */
  x: number;
  y: number;
  rotation: number;
  sx: number;
  sy: number;
  fill: Paint;
  stroke?: Stroke;
  shadow?: Shadow;
}

export type RectLayer = LayerBase & { type: 'rect'; w: number; h: number; radius: number };
export type EllipseLayer = LayerBase & { type: 'ellipse'; w: number; h: number };
export type PolygonLayer = LayerBase & { type: 'polygon'; w: number; h: number; sides: number; star: boolean; inner: number };
export type PathLayer = LayerBase & { type: 'path'; points: PathPoint[]; closed: boolean };
export type BrushLayer = LayerBase & { type: 'brush'; points: [number, number][] };
export type TextLayer = LayerBase & {
  type: 'text';
  text: string;
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  /** Extra space between letters, in units. */
  spacing: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  /** Bend along an arc, in degrees (negative bends down). */
  arc: number;
  /** Run along this path instead (in the layer's own frame). */
  path?: PathPoint[];
  /** Where along the path the text sits (0–1), and whether it runs the other way (other side). */
  pathStart?: number;
  pathFlip?: boolean;
};
export type ImageLayer = LayerBase & { type: 'image'; asset: string; w: number; h: number };

export type Layer = RectLayer | EllipseLayer | PolygonLayer | PathLayer | BrushLayer | TextLayer | ImageLayer;
export type LayerType = Layer['type'];

export interface Design {
  version: 1;
  /** Bottom to top. */
  layers: Layer[];
  /** Images, as data URLs, by id. */
  assets: Record<string, string>;
  /** Font files added to the design, base64, by family name. */
  fonts: Record<string, string>;
  /** Group names (and whether they're folded in the layer list), by id. */
  groups?: Record<string, { name: string; collapsed?: boolean }>;
}

export const emptyDesign = (): Design => ({ version: 1, layers: [], assets: {}, fonts: {}, groups: {} });

let counter = 0;
export const newId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

const base = (name: string, x: number, y: number, fill: Paint): LayerBase => ({
  id: newId(),
  name,
  visible: true,
  locked: false,
  opacity: 1,
  blend: 'source-over',
  clip: false,
  x,
  y,
  rotation: 0,
  sx: 1,
  sy: 1,
  fill,
});

export const solid = (colour: Colour): Paint => ({ kind: 'solid', colour });

export function makeLayer(type: LayerType, x: number, y: number, extra: Partial<Layer> = {}): Layer {
  const blue = solid('#1f4fbf');
  let layer: Layer;
  switch (type) {
    case 'rect':
      layer = { ...base('Rectangle', x, y, blue), type, w: 400, h: 200, radius: 0 };
      break;
    case 'ellipse':
      layer = { ...base('Ellipse', x, y, blue), type, w: 300, h: 300 };
      break;
    case 'polygon':
      layer = { ...base('Star', x, y, solid('#f2c230')), type, w: 300, h: 300, sides: 5, star: true, inner: 0.45 };
      break;
    case 'path':
      layer = { ...base('Path', x, y, blue), type, points: [], closed: true };
      break;
    case 'brush':
      layer = {
        ...base('Brush stroke', x, y, { kind: 'none' }),
        type,
        points: [],
        stroke: { paint: solid('#ffffff'), width: 24, join: 'round', cap: 'round', dash: 0, behind: false },
      };
      break;
    case 'text':
      layer = {
        ...base('Text', x, y, solid('#ffffff')),
        type,
        text: 'POLICE',
        font: 'Arial Black',
        size: 160,
        weight: 900,
        italic: false,
        spacing: 0,
        lineHeight: 1.1,
        align: 'center',
        arc: 0,
        stroke: { paint: solid('#000000'), width: 10, join: 'round', cap: 'round', dash: 0, behind: true },
      };
      break;
    case 'image':
      layer = { ...base('Image', x, y, { kind: 'none' }), type, asset: '', w: 512, h: 512 };
      break;
  }
  return { ...layer, ...extra } as Layer;
}

export function cloneLayer<T extends Layer>(l: T): T {
  return JSON.parse(JSON.stringify(l)) as T;
}

/** Parses a saved design, filling in anything missing. */
export function parseDesign(text: string): Design {
  const d = JSON.parse(text) as Partial<Design>;
  if (!d || !Array.isArray(d.layers)) throw new Error('Not a livery design file.');
  return { version: 1, layers: d.layers, assets: d.assets ?? {}, fonts: d.fonts ?? {}, groups: d.groups ?? {} };
}

/** A design with only the assets and fonts its layers use. */
export function packDesign(d: Design): Design {
  const assets = new Set(d.layers.filter((l): l is ImageLayer => l.type === 'image').map((l) => l.asset));
  const fonts = new Set(d.layers.filter((l): l is TextLayer => l.type === 'text').map((l) => l.font));
  const groups = new Set(d.layers.map((l) => l.group).filter(Boolean));
  return {
    version: 1,
    layers: d.layers,
    groups: Object.fromEntries(Object.entries(d.groups ?? {}).filter(([k]) => groups.has(k))),
    assets: Object.fromEntries(Object.entries(d.assets).filter(([k]) => assets.has(k))),
    fonts: Object.fromEntries(Object.entries(d.fonts).filter(([k]) => fonts.has(k))),
  };
}
