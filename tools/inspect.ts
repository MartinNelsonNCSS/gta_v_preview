/* Parses GTA V asset files and prints a summary. Usage: node out/inspect.js <files...> */
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { parseYdr, parseYdd } from '../src/formats/drawable';
import { parseYtd } from '../src/formats/ytd';
import { parseYtyp } from '../src/formats/ytyp';
import { parseYmap } from '../src/formats/ymap';
import { parseYft } from '../src/formats/yft';
import { parseYbn } from '../src/formats/bounds';
import type { DrawableData } from '../src/shared/model';

const opts = { maxSize: 1024 };
const verbose = process.argv.includes('-v');

function summarizeDrawable(d: DrawableData) {
  const lods = Object.entries(d.lods)
    .filter(([, m]) => m.length)
    .map(([k, m]) => {
      const meshes = m.flatMap((x) => x.meshes);
      const verts = meshes.reduce((a, g) => a + g.positions.length / 3, 0);
      const tris = meshes.reduce((a, g) => a + g.indices.length / 3, 0);
      return `${k}:${m.length}m/${meshes.length}g/${verts}v/${tris}t`;
    });
  console.log(`  drawable "${d.name}" bb=[${d.bbMin.map((v) => v.toFixed(2))}]..[${d.bbMax.map((v) => v.toFixed(2))}] ${lods.join(' ')}`);
  console.log(`    shaders: ${d.shaders.map((s) => `${s.name}(${s.diffuse ?? '-'})`).join(', ')}`);
  console.log(`    embedded textures: ${d.textures.map((t) => `${t.name} ${t.width}x${t.height} ${t.format}${t.pixels ? '' : ' (no data)'}`).join(', ') || 'none'}; external refs: ${d.hasExternalTextures}`);
  if (d.bones.length) console.log(`    bones: ${d.bones.length} [${d.bones.slice(0, 6).map((b) => b.name).join(', ')}...]`);
  if (verbose) {
    for (const s of d.shaders) console.log(`      ${s.name} / ${s.file} bucket=${s.renderBucket} ${s.textures.map((t) => `${t.param}=${t.texture}`).join(' ')}`);
    const g = d.lods.high[0]?.meshes[0];
    if (g) {
      console.log('      first verts', Array.from(g.positions.slice(0, 6)).map((v) => v.toFixed(4)).join(' '), 'uv', g.uvs && Array.from(g.uvs.slice(0, 4)).map((v) => v.toFixed(4)).join(' '), 'n', g.normals && Array.from(g.normals.slice(0, 3)).map((v) => v.toFixed(4)).join(' '));
    }
    d.lods.high.forEach((m, i) => console.log(`      model ${i} bone=${m.boneIndex} skinned=${m.skinned} mask=${m.renderMask}`));
  }
}

for (const file of process.argv.slice(2).filter((a) => !a.startsWith('-'))) {
  const ext = file.split('.').pop()!.toLowerCase();
  console.log(`== ${file}`);
  try {
    const data = readFileSync(file);
    const t0 = Date.now();
    if (ext === 'ydr') summarizeDrawable(parseYdr(data, opts));
    else if (ext === 'ydd') parseYdd(data, opts).forEach(summarizeDrawable);
    else if (ext === 'yft') parseYft(data, opts).forEach(summarizeDrawable);
    else if (ext === 'ytd') {
      const t = parseYtd(data, opts);
      console.log(`  ${t.length} textures: ${t.map((x) => `${x.name} ${x.width}x${x.height} ${x.format}${x.pixels ? '' : ' (no data)'}`).join(', ')}`);
    } else if (ext === 'ybn') {
      const b = parseYbn(data);
      console.log(`  bb=[${b.bbMin.map((v) => v.toFixed(2))}]..[${b.bbMax.map((v) => v.toFixed(2))}] tris=${b.triangles} prims=${b.primitives.length} types=${JSON.stringify(b.typeCounts)}`);
      console.log(`  materials: ${b.materials.slice(0, 8).map((m) => `${m.name}(${m.count})`).join(', ')}`);
      if (verbose) console.log('  first tri', Array.from(b.positions.slice(0, 9)).map((v) => v.toFixed(2)).join(' '), 'prims', JSON.stringify(b.primitives.slice(0, 3)));
    } else if (ext === 'ymap') {
      const known: string[] = [];
      const walk = (d: string, depth: number) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory() && depth < 3) walk(join(d, e.name), depth + 1); else known.push(e.name.replace(/\.[^.]+$/, '')); } };
      walk(dirname(dirname(file)), 0);
      const y = parseYmap(data, { knownNames: known });
      console.log(`  name=${y.name} parent=${y.parent} flags=${y.flags} content=${y.contentFlags} entities=${y.entities.length} cargens=${y.carGenerators.length} tcm=${y.timecycleModifiers.length} occl=${y.boxOccluders}/${y.occludeModels} grass=${y.grassBatches} lodlights=${y.lodLights} phys=${y.physicsDictionaries.join(',')}`);
      console.log(`  extents ${JSON.stringify(y.entitiesExtents.map((v) => v.map((x) => +x.toFixed(1))))} block=${JSON.stringify(y.block)}`);
      for (const e of y.entities.slice(0, verbose ? 1000 : 6)) console.log(`    ${e.isMloInstance ? '[MLO] ' : ''}${e.archetype} pos=${e.position.map((v) => v.toFixed(2))} rot=${e.rotation.map((v) => v.toFixed(3))} lod=${e.lodLevel} parent=${e.parentIndex}`);
      for (const c of y.carGenerators.slice(0, 3)) console.log(`    cargen ${c.model} pos=${c.position.map((v) => v.toFixed(1))} orient=${c.orientX.toFixed(2)},${c.orientY.toFixed(2)} len=${c.perpendicularLength}`);
    } else if (ext === 'ytyp') {
      const known: string[] = [];
      const walk = (d: string, depth: number) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory() && depth < 3) walk(join(d, e.name), depth + 1); else known.push(e.name.replace(/\.[^.]+$/, '')); } };
      walk(dirname(dirname(file)), 0);
      const y = parseYtyp(data, { knownNames: known });
      console.log(`  name=${y.name} deps=${y.dependencies.join(',')}`);
      for (const a of y.archetypes) {
        console.log(`  ${a.type} ${a.name} asset=${a.assetName} txd=${a.textureDictionary} type=${a.assetType} lod=${a.lodDist} flags=${a.flags}`);
        if (a.mlo) {
          console.log(`    MLO: ${a.mlo.entities.length} entities, ${a.mlo.rooms.length} rooms, ${a.mlo.portals.length} portals, sets=${a.mlo.entitySets.map((s) => s.name).join(',')}`);
          for (const e of a.mlo.entities.slice(0, verbose ? 1000 : 5)) console.log(`      ${e.archetype} pos=${e.position.map((v) => v.toFixed(2))} rot=${e.rotation.map((v) => v.toFixed(3))} room=${e.room ?? ''} set=${e.entitySet ?? ''}`);
          for (const r of a.mlo.rooms.slice(0, 5)) console.log(`      room ${r.name} ents=${r.entityIndices.length}`);
        }
      }
      if (verbose) console.log(JSON.stringify(y.raw, null, 1).slice(0, 6000));
    }
    console.log(`  (${Date.now() - t0} ms)`);
  } catch (e) {
    console.log(`  ERROR: ${(e as Error).stack}`);
  }
}
