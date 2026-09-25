# GTA V Asset Preview

Preview Grand Theft Auto V resource files directly in VS Code:

| File    | What you get                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------ |
| `.ydr`  | 3D model viewer: LODs, textures, wireframe, bounds, embedded collision, shader/texture list, skeleton |
| `.ydd`  | Same viewer, with a picker for each drawable in the dictionary                                        |
| `.yft`  | Fragments (vehicles, breakable props, liveries): the main model plus damaged/extra drawables          |
| `.ytyp` | Archetype table with live model preview, **MLO interiors assembled in 3D**, and a raw meta tree       |
| `.ymap` | Map entities placed in the world, **MLO instances expanded**, car generators, extents, raw meta tree |
| `.ymt`  | Ped variation (clothing/addon peds): browse components & props, texture variations, 3D preview; raw tree for other meta |
| `.ybn`  | Collision viewer: meshes and primitives colour-coded by material, per-material filter, click to identify |
| `.ytd`  | Texture gallery with a full-size viewer (RGB / alpha channels)                                        |

Everything is implemented in TypeScript (RSC7 decompression, drawable/meta parsing, DXT/BC texture decoding),
so there are no native binaries or external tools like CodeWalker. It works the same on Windows, macOS, Linux,
Remote/WSL, and in vscode.dev.

## Install

- **VS Code:** search for "GTA V Asset Preview" in the Extensions view, or install
  [`ncss-ltd.gta-v-asset-preview`](https://marketplace.visualstudio.com/items?itemName=ncss-ltd.gta-v-asset-preview)
  from the Marketplace.
- **Cursor, VSCodium, Windsurf and other forks:** install it from
  [Open VSX](https://open-vsx.org/extension/ncss-ltd/gta-v-asset-preview).
- **Manually:** download the `.vsix` from the [releases page](https://github.com/MartinNelsonNCSS/gta_v_preview/releases),
  then use **Extensions → ··· → Install from VSIX…**.

## Usage

Open any `.ydr`, `.ydd`, `.yft`, `.ytyp`, `.ymap`, `.ymt`, `.ybn` or `.ytd` file. The preview opens automatically.

- **Orbit**: left-drag. **Pan**: right-drag or shift-drag. **Zoom**: scroll.
- **Cut** slider: hides everything above a height, which helps when looking into interiors.
- **External textures**: models usually reference textures stored in a separate `.ytd`. The preview searches
  the workspace for them, starting with the dictionary named by the archetype, then the nearest `.ytd` files.
  In the sidebar, green means the texture was found, red means it wasn't.
- **Interiors (MLO)**: every entity is placed using the `.ydr`/`.ydd` files found in the workspace. Base-game
  models that aren't in your workspace are shown as grey boxes. Click an entity (or pick one from the room list)
  to inspect it. You can toggle entity sets, portals and room bounds.
- **Maps**: `.ymap` entities are loaded the same way as interiors. Their archetype definitions (drawable
  dictionary, MLO layout) come from any `.ytyp` in the workspace, so interiors placed by a map are expanded in
  place. LOD entities are hidden by default; toggle **LOD entities** to see them.
- **Collision**: `.ybn` files and collision embedded in drawables (the **Collision** toggle) are coloured by
  material. Click a surface to see its material. Material names follow the standard `materials.dat` order;
  the numeric index is shown alongside for cross-checking.
- **Ped clothing (`.ymt`)**: lists every component (masks, torsos, legs, tops, ...) and prop (hats, glasses, watches, ...)
  with its texture variations, using the files next to the `.ymt` (streamed `ped^jbib_000_u.ydd` or plain `jbib_000_u.ydd`
  names). Pick a drawable to see its model with the selected variation's texture applied; dots show whether each
  model file exists. Encrypted (escrow) models still show their texture variations.
- **Replacing and exporting textures**: click any texture (sidebar thumbnail, shader texture name, `.ytd` card, or a
  `.ymt` variation via double-click) to open the viewer:
  - **Replace…** picks a PNG/JPG/WebP/BMP/DDS and previews it on the model straight away. Nothing is written yet.
  - **Size**, **Format** and **Mips** pick the resolution, compression and number of mipmap levels to save with (they
    also work on their own, to rescale or convert the existing texture, or add/remove mipmaps). Formats: DXT1/3/5, BC4, BC5, A8R8G8B8, A8B8G8R8, X8R8G8B8, L8 and A8. The preview
    shows the real compression result, and the viewer shows the resulting data size.
    - In a `.ytd`, anything goes: when the new data doesn't fit, the `.ytd` is rebuilt with a fresh page layout.
    - Embedded in a `.ydr`/`.ydd`/`.yft`, the new data must fit in the texture's existing space (e.g. DXT5 → DXT1, or
      DXT1 → DXT5 at half size). Sizes that won't fit are greyed out.
    - Replacing with a `.dds` whose format and size match keeps its data as-is, including its own mipmaps (no
      re-encoding). This is also the way to store BC7: replace with a BC7 `.dds`.
    - BC7 textures can be converted to another format.
  - **Save to file** writes it into the file the texture actually lives in (the `.ytd`, or the `.ydr`/`.ydd`/`.yft` that
    embeds it), after confirmation. The image is re-encoded in the texture's current format (DXT1/3/5, BC4/5 or
    uncompressed) with a full mip chain. The first time a file is changed, the original is kept next to it as
    `<file>.bak`.
  - **Revert** discards an unsaved change. **Export PNG** / **Export DDS** save the texture: DDS exports the exact
    original data, or, when you've changed size/format/mips, a DDS encoded with those settings.
- **Converting images to DDS**: right-click one or more PNG/JPG/WebP/BMP/GIF/DDS files in the Explorer and choose
  **Convert to DDS…** (or run **GTA V: Convert to DDS…** from the command palette). Pick the format (DXT1, DXT5, ...),
  mipmaps (full chain, down to 4×4, or none) and size (original, nearest power of two, or a maximum), check the
  preview, and convert. Each `.dds` is written next to its source image.
- **XML files**: `.ytyp`/`.ymap`/`.ymt` files saved as XML show their text with an **Open as text** button.
- The preview reloads automatically when the file changes on disk (for example when you re-export from Sollumz).

## Workspace tools (GTA V sidebar)

Open the **GTA V** view in the activity bar:

- **Assets** lists every resource's models, texture dictionaries, archetypes, maps, collisions and ped files, with
  memory use, expandable to their contents (textures, the textures a model uses and where each comes from,
  archetypes, placed props). **Find Asset…** (search icon) searches files, textures and archetypes by name.
  **Find Usages** (right-click, or the inline icon) answers "which models use this texture?", "which maps place this
  archetype?", "where is this texture defined?".
- **Resource Health** (**Check Resources**) scans the workspace and reports in the Problems panel:
  - **oversized assets** — files over 16 MiB of physical or virtual memory, with the same 16/32/48 MiB levels FiveM
    warns at, naming the biggest textures;
  - **missing textures** that aren't embedded or in any `.ytd` (info only, base-game textures are expected);
  - **archetypes with no model file**, and maps placing **interiors that aren't defined** anywhere;
  - streamed **`.ytyp` files missing from `data_file 'DLC_ITYP_REQUEST'`** in `fxmanifest.lua` (with the line to add),
    and map resources without `this_is_a_map 'yes'`;
  - **name clashes** (the same file streamed by more than one resource), escrow-encrypted and unreadable files;
  - **texture hints**: no mipmaps, uncompressed or very large textures.
- **Optimize Textures…** (also on folders and `.ytd` files in the Explorer) caps texture sizes, adds missing
  mipmaps and compresses uncompressed textures across a resource or the whole workspace. It lists every change with
  the exact memory saving before you apply it; halving reuses existing mipmaps (lossless), and each `.ytd` is rebuilt
  so its streaming memory actually shrinks. Originals are kept as `.bak`.

## Settings

| Setting                     | Default     | Description                                                                               |
| --------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `gtaPreview.assetSearch`    | `workspace` | Where to look for referenced `.ytd`/`.ydr`/`.ydd` files: `workspace`, `folder`, or `off`. |
| `gtaPreview.maxTextureSize` | `1024`      | Largest texture dimension decoded; bigger textures use a smaller mip level.                |

## Limitations

- **FiveM escrow (`FXAP`) files are encrypted** and can't be previewed. The editor says so when you open one.
- Gen9 / Enhanced-edition (`RSC8`) resources and PSO-format (binary `PSIN`) `.ymt` files aren't supported yet.
- Textures embedded in `.ydr`/`.ydd`/`.yft` can't grow beyond their current data size; move them to a `.ytd` for
  that. Encoding to BC7 or 16-bit formats isn't supported (BC7 can be stored from a BC7 `.dds`). Power-of-two sizes are the safest choice for the game.
- `.yft`: fragment physics (per-part collision, breakable children) isn't shown. Vehicle paint is drawn as neutral grey and
  shared vehicle textures (`vehshare.ytd`) are base-game files, so they're usually missing.
- Only the diffuse texture is used for shading. Normal and specular maps are listed and viewable but not rendered.
- Base-game names that aren't present as files nearby show as `hash_XXXXXXXX`, and base-game models show as boxes.
- `.ymap` grass instances, occluders and LOD lights are counted but not drawn.
- BC7 textures are decoded on the GPU, so they need a GPU/driver that supports `EXT_texture_compression_bptc`.

## Development

```bash
npm install
npm run build        # or: npm run watch
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host ("Run Extension").

Other tools:

- `npm run inspect -- path/to/file.ydr [-v]` prints what the parsers see (models, shaders, textures, archetypes).
- `npm run harness -- <folder-with-assets>` serves the real webview and extension-host code in a normal browser
  (with a stubbed `vscode` module) at <http://localhost:5178>. This makes UI work fast to iterate on.
- `npm run hosttest -- path/to/file.ytyp` runs the real extension-host code under Node (with a stubbed `vscode`
  module) and reports what it would send to the webview: texture search results, MLO models found, etc.
- `npm run test:vscode -- <folder> [path-to-vscode-executable]` runs an end-to-end check inside a real VS Code
  (activation, commands, health check diagnostics, editors and panels) against a folder of assets.
- `npm run package` builds a `.vsix`.

### Releasing

Bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, then push a tag (`git tag v1.2.3 && git push origin v1.2.3`).
The release workflow builds the `.vsix`, attaches it to a GitHub release, and publishes it to the Marketplace and
Open VSX when the `VSCE_PAT` / `OVSX_PAT` repository secrets are set.

### Layout

```
src/formats/    Pure parsers (no VS Code / DOM deps): rsc7, reader, drawable, textures, bounds, meta, ytyp, ymap, ytd, hash
src/host/       Extension host: custom editor provider, workspace asset index (texture/model lookup)
src/webview/    three.js viewer and UI (model panel, ytd gallery, ytyp/MLO views)
src/shared/     Message and data types shared by host and webview
tools/          CLI inspector and browser harness
```


## License

Copyright (c) 2026 Martin J Nelson III.

This project is free and open-source software, licensed under the
[GNU General Public License v3.0](LICENSE) (GPL-3.0-only). In short: you can use, study, modify and share it. If
you distribute it, or a modified version, you must make the full source code available under the same license
and keep the copyright and license notices.

Bundled third-party libraries (three.js, fflate) keep their own MIT licenses, which are compatible with the GPL; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Disclaimer

This is an unofficial, fan-made tool. It is not affiliated with, endorsed by, or associated with Rockstar Games or
Take-Two Interactive. *Grand Theft Auto* and *GTA* are trademarks of Take-Two Interactive Software, Inc. No game
assets are included in this repository or the extension; it only reads files you already have.

The file-format knowledge used here comes from the modding community's public reverse-engineering work, notably
[CodeWalker](https://github.com/dexyfex/CodeWalker) and [Sollumz](https://github.com/Sollumz/Sollumz). All code in
this repository was written independently.
