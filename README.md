# GTA V Asset Preview

Preview Grand Theft Auto V resource files directly in VS Code:

| File    | What you get                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------ |
| `.ydr`  | 3D model viewer: LODs, textures, wireframe, bounds, embedded collision, shader/texture list, skeleton |
| `.ydd`  | Same viewer, with a picker for each drawable in the dictionary                                        |
| `.ytyp` | Archetype table with live model preview, **MLO interiors assembled in 3D**, and a raw meta tree       |
| `.ymap` | Map entities placed in the world, **MLO instances expanded**, car generators, extents, raw meta tree |
| `.ybn`  | Collision viewer: meshes and primitives colour-coded by material, per-material filter, click to identify |
| `.ytd`  | Texture gallery with a full-size viewer (RGB / alpha channels)                                        |

Everything is implemented in TypeScript (RSC7 decompression, drawable/meta parsing, DXT/BC texture decoding),
so there are no native binaries or external tools like CodeWalker. It works the same on Windows, macOS, Linux,
Remote/WSL, and in vscode.dev.

## Usage

Open any `.ydr`, `.ydd`, `.ytyp`, `.ymap`, `.ybn` or `.ytd` file. The preview opens automatically.

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
- The preview reloads automatically when the file changes on disk (for example when you re-export from Sollumz).

## Settings

| Setting                     | Default     | Description                                                                               |
| --------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `gtaPreview.assetSearch`    | `workspace` | Where to look for referenced `.ytd`/`.ydr`/`.ydd` files: `workspace`, `folder`, or `off`. |
| `gtaPreview.maxTextureSize` | `1024`      | Largest texture dimension decoded; bigger textures use a smaller mip level.                |

## Limitations

- **FiveM escrow (`FXAP`) files are encrypted** and can't be previewed. The editor says so when you open one.
- Gen9 / Enhanced-edition (`RSC8`) resources, `.yft` fragments and XML exports (`.ytyp.xml`) aren't supported yet.
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
- `npm run package` builds a `.vsix`. Set `publisher` in `package.json` first.

### Layout

```
src/formats/    Pure parsers (no VS Code / DOM deps): rsc7, reader, drawable, textures, bounds, meta, ytyp, ymap, ytd, hash
src/host/       Extension host: custom editor provider, workspace asset index (texture/model lookup)
src/webview/    three.js viewer and UI (model panel, ytd gallery, ytyp/MLO views)
src/shared/     Message and data types shared by host and webview
tools/          CLI inspector and browser harness
```

Format knowledge is based on the community's reverse-engineering work, notably CodeWalker and Sollumz.
