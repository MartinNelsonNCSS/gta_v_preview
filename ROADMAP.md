# Roadmap

Ideas for making FiveM / GTA V modding workflows faster, roughly in priority order.

## Done (0.9.0)

### 1. Resource health check
Scan a workspace (or folder) of FiveM resources and report problems in VS Code's **Problems** panel and a
**Resource Health** view:

- **Oversized assets** — streamed files whose system or graphics memory exceeds 16 MiB (FiveM warns about these
  and they can fail to stream), with the biggest textures inside named.
- **Missing textures** — shader textures that aren't embedded and aren't in any `.ytd` in the workspace.
- **Broken references** — `.ytyp` archetypes with no model file; `.ymap` entities whose archetype isn't defined in
  the workspace.
- **Manifest gaps** — streamed `.ytyp` files without a matching `data_file 'DLC_ITYP_REQUEST'` entry in
  `fxmanifest.lua`.
- **Name clashes** — the same asset file name streamed by more than one resource.
- **Escrow-encrypted files** and unreadable files.
- **Texture hints** — missing mipmaps, uncompressed or very large textures (fixable with the optimiser).

### 2. Batch texture optimiser
Across a resource or the whole workspace: cap texture sizes (halving uses the existing mipmaps, so there's no
quality loss), add missing mipmaps, and compress uncompressed textures to DXT1/DXT5. Shows candidates and
estimated memory savings first, keeps `.bak` backups, and reports before/after sizes.

### 3. Asset browser with "Find Usages"
A **GTA V** sidebar listing every resource's models, texture dictionaries, archetypes, maps, collisions and ped
files, expandable to their contents. **Find Usages** answers "which models use this texture?", "which maps place
this archetype?", "where is this texture defined?". **Find Asset…** searches everything by name.

## Later

- **CodeWalker / Sollumz XML** export and import for round-tripping with other tools.
- **Clothing pack editing** — add drawables and texture variations to a `.ymt` (overlaps with grzyClothTool).
- **Full ped / vehicle assembly** — preview all components of a ped or vehicle together in one 3D view.
- **Fragment physics** — per-part collision and breakable children in `.yft`.
- **Gen9 (RSC8)** resources.
- **PSO-format `.ymt`** files.

## Not planned

- **Zed support** — Zed extensions can't provide custom editors, webviews or UI panels, which every preview here
  depends on.
