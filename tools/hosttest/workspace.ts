/* Runs the workspace index, health checks, asset tree and usages against a folder. Usage: node out/wstest.js <folder> */
import { testRoot, Uri } from './vscode-stub';
import { WorkspaceIndex } from '../../src/host/workspaceIndex';
import { runChecks } from '../../src/host/healthCheck';
import { AssetTreeProvider } from '../../src/host/assetTree';
import { planTexture } from '../../src/formats/optimize';

testRoot.path = process.argv[2];
(async () => {
  const index = new WorkspaceIndex();
  let t = Date.now();
  await index.refresh();
  console.log(`indexed ${index.all.length} files in ${index.resourceList.length} resources (${Date.now() - t} ms)`);
  t = Date.now();
  await index.refresh();
  console.log(`rescan with cache: ${Date.now() - t} ms`);
  const byKind: Record<string, number> = {};
  for (const a of index.all) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  console.log('kinds', JSON.stringify(byKind), '| encrypted', index.all.filter((a) => a.summary.encrypted).length, '| errors', index.all.filter((a) => a.summary.error).map((a) => `${a.file}: ${a.summary.error}`));

  const issues = runChecks(index);
  const sev = ['error', 'warning', 'info', 'hint'];
  const byCode: Record<string, number> = {};
  for (const i of issues) byCode[`${sev[i.severity]}:${i.code}`] = (byCode[`${sev[i.severity]}:${i.code}`] ?? 0) + 1;
  console.log('issues', JSON.stringify(byCode));
  for (const code of Object.keys(byCode)) {
    const i = issues.find((x) => `${sev[x.severity]}:${x.code}` === code)!;
    console.log(`  e.g. [${code}] ${i.uri.path.split('/').pop()}: ${i.message.slice(0, 230)}`);
  }

  const tree = new AssetTreeProvider(index);
  const roots = tree.getChildren();
  console.log('tree roots:', roots.map((n) => { const it = tree.getTreeItem(n); return `${it.label} (${it.description})`; }).join(' | '));
  const prison = roots.find((n) => n.type === 'resource' && n.resource.name.startsWith('prison'));
  if (prison) {
    const cats = tree.getChildren(prison);
    console.log('prison categories:', cats.map((n) => { const it = tree.getTreeItem(n); return `${it.label}=${it.description}`; }).join(', '));
    const models = cats.find((c) => tree.getTreeItem(c).label === 'Models')!;
    const stairs = tree.getChildren(models).find((f) => tree.getTreeItem(f).label === 'brown_prison_stairs_01.ydr')!;
    console.log('stairs children:', tree.getChildren(stairs).map((n) => { const it = tree.getTreeItem(n); return `${it.label} [${it.description}] ctx=${it.contextValue}`; }).join(' | '));
    const shell = tree.getChildren(models).find((f) => tree.getTreeItem(f).label === 'brown_prison_shell.ydr')!;
    console.log('shell refs:', tree.getChildren(shell).slice(0, 4).map((n) => { const it = tree.getTreeItem(n); return `${it.label} [${it.description}]`; }).join(' | '));
  }
  // Optimiser plans at a 512 cap.
  const ytds = index.all.filter((a) => a.kind === 'ytd' && a.summary.textures);
  const plans = ytds.flatMap((a) => a.summary.textures!.map((x) => planTexture(x, { maxSize: 512, addMips: true, compress: true })).filter(Boolean));
  console.log(`optimiser @512: ${plans.length} textures in ${ytds.length} readable .ytd files would change`);
})();
