# Changelog

## 0.11.0

- **Cloth physics preview (`.yld`)**: the simulated cloth mesh (pinned and free vertices, links) over its clothing model with the first texture variation, plus the body collision shapes it reacts to on a reference ped. Toggle each layer; the sidebar lists counts, pinned bones and collision shapes per bone.
- `.ymt` clothing browser: drawables with cloth physics are marked, with an **Open cloth** button.
- **Texture dictionary management**: **Add Textures…** and **Delete Textures…** in the `.ytd` toolbar, and **Rename…** and **Delete** in the texture viewer. New images get a name, format (or keep a `.dds` as-is), optional power-of-two resize and mipmaps; the `.ytd` is rebuilt with entries sorted by name hash, and a `.bak` of the original is kept.

## 0.10.0

- **Animation preview (`.ycd`)**: play, pause, step and scrub clips, with speed, looping and root motion.
  - Ped animations play on a built-in GTA V ped skeleton, so no ped model is needed.
  - Vehicle and prop animations (e.g. `va_<vehicle>.ycd` convertible roofs) play on the matching model in the same folder.
  - Sidebar with clip range, frames, track types, events and animated bones; dictionaries with several clips get a clip picker.

## 0.9.0

- **GTA V sidebar** with an **Assets** browser (resources → models, texture dictionaries, archetypes, maps, collisions, ped files → contents), **Find Asset…** and **Find Usages**.
- **Resource Health** check: oversized assets (FiveM's 16/32/48 MiB levels), missing textures and models, undefined interiors, fxmanifest `DLC_ITYP_REQUEST` gaps, name clashes, encrypted files and texture hints — in the Problems panel and a sidebar view.
- **Optimize Textures…**: batch cap sizes / add mipmaps / compress across a resource or workspace with exact memory estimates; `.ytd` files are rebuilt so memory really shrinks.

## 0.8.0

- **Convert to DDS…**: convert PNG/JPG/WebP/BMP/GIF/DDS images to `.dds` (DXT1/DXT5/BC4/BC5/uncompressed) with generated mipmaps, from the Explorer context menu or command palette.
- Mipmap count when saving textures (1 up to the full chain).
- Replacing with a matching `.dds` keeps its data and mipmaps as-is; BC7 can be stored this way.
- Export DDS uses the chosen size/format/mips (or the exact original data when unchanged).

## 0.7.0

- Change texture format (DXT1/3/5, BC4/5, uncompressed); BC7 textures can be converted to another format.
- The preview shows the actual compression result, plus the new data size.
- Embedded textures can use any size/format that fits in their existing space (not just halving); sizes that don't fit are greyed out.

## 0.6.0

- Change texture resolution: any size for textures in a `.ytd` (rebuilt with a new page layout), halving for textures embedded in `.ydr`/`.ydd`/`.yft`.
- The size picker also rescales a texture without replacing its image.

## 0.5.0

- Replace textures: preview any PNG/JPG/WebP/BMP/DDS on the model, then save it into the `.ytd`/`.ydr`/`.ydd`/`.yft` (re-encoded to the texture's size and format with mips; `.bak` backup kept).
- Export textures as PNG or DDS.
- Click a texture name in the shader list to open it.

## 0.4.3

- Published under the `ncss-ltd` publisher, with an extension icon.
- Releases publish to the VS Code Marketplace and Open VSX automatically.

## 0.4.2

- Relicensed under the GNU General Public License v3.0 (GPL-3.0-only).

## 0.4.1

- Licensed under the PolyForm Noncommercial License 1.0.0.
- The extension package now includes the license and third-party notices (three.js, fflate).
- README: license summary, disclaimer and credits.

## 0.4.0

- `.ymt` preview: ped variation browser (components, props, texture variations, 3D preview with the variation applied); raw tree for other RSC7 meta files.
- XML `.ytyp`/`.ymap`/`.ymt` files show their text with an "Open as text" button instead of an error.
- Clear message for PSO-format meta files.

## 0.3.0

- `.yft` preview: fragments (vehicles, breakable props, liveries) with the main, damaged and extra drawables.
- Vehicle paint shaders render in neutral paint grey with liveries composited on top.
- `.ytyp`/`.ymap`: archetypes of type fragment now load their `.yft`; double-click opens it.

## 0.2.0

- `.ymap` preview: entities placed in 3D, MLO instances expanded from nearby `.ytyp` files, car generators, extents, LOD filter, raw tree.
- `.ybn` preview: collision meshes and primitives coloured by material, material filter, click to identify.
- `.ydr`/`.ydd`: **Collision** toggle for embedded bounds.
- Archetype lookup now searches every `.ytyp` in the workspace (drawable dictionaries, interior layouts).

## 0.1.0

- Initial release: previews for .ydr, .ydd, .ytyp (including MLO interiors) and .ytd.
