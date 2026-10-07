/* Runs inside a real VS Code extension host (see run.mjs). Writes results to $GTA_TEST_OUT. */
import * as vscode from 'vscode';
import { writeFileSync } from 'fs';

export async function run(): Promise<void> {
  const results: { name: string; ok: boolean; detail?: string }[] = [];
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || undefined });
    } catch (err) {
      results.push({ name, ok: false, detail: (err as Error).stack ?? String(err) });
    }
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  await check('extension activates', async () => {
    const ext = vscode.extensions.getExtension('ncss-ltd.gta-v-asset-preview');
    if (!ext) throw new Error('extension not found');
    await ext.activate();
    return `v${ext.packageJSON.version}`;
  });
  await check('commands registered', async () => {
    const all = await vscode.commands.getCommands(true);
    const ours = all.filter((c) => c.startsWith('gtaPreview.'));
    for (const c of ['gtaPreview.checkResources', 'gtaPreview.optimizeTextures', 'gtaPreview.findAsset', 'gtaPreview.findUsages', 'gtaPreview.convertToDds', 'gtaPreview.refreshAssets']) {
      if (!ours.includes(c)) throw new Error(`missing ${c}`);
    }
    return ours.join(', ');
  });
  await check('health check → Problems panel', async () => {
    await vscode.commands.executeCommand('gtaPreview.checkResources');
    const diags = vscode.languages.getDiagnostics().flatMap(([uri, ds]) => ds.filter((d) => d.source === 'GTA V').map((d) => `${uri.path.split('/').pop()}: [${d.code}] ${d.message.slice(0, 90)}`));
    // Which problems exist depends on the workspace; this checks the scan runs and reports.
    return diags.length ? diags.slice(0, 12).join('\n      ') : 'no problems found';
  });
  await check('sidebar views open', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.gtaPreview');
    await vscode.commands.executeCommand('gtaPreview.assets.focus');
    await vscode.commands.executeCommand('gtaPreview.health.focus');
  });
  const openTab = async (uri: vscode.Uri, viewType: string) => {
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
    await sleep(1500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input as { viewType?: string } | undefined;
    if (!input?.viewType?.endsWith(viewType)) throw new Error(`active tab is ${tab?.label} (${JSON.stringify(input)})`);
    return `${tab!.label}`;
  };
  /** First file with this extension in the workspace (the suite adapts to whatever assets it's given). */
  const sample = async (ext: string) => (await vscode.workspace.findFiles(`**/*.${ext}`, '**/node_modules/**', 1))[0];
  for (const ext of ['ydr', 'ydd', 'yft', 'ytd', 'ytyp', 'ymap', 'ybn', 'ymt', 'ycd']) {
    const uri = await sample(ext);
    if (uri) await check(`custom editor opens .${ext}`, () => openTab(uri, `gtaPreview.${ext}`));
  }
  await check('Convert to DDS panel', async () => {
    const image = (await sample('png')) ?? (await sample('jpg'));
    if (!image) return 'skipped (no image in the workspace)';
    await vscode.commands.executeCommand('gtaPreview.convertToDds', image);
    await sleep(1000);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    if (!tabs.some((t) => t.includes('to DDS'))) throw new Error(`tabs: ${tabs}`);
    return tabs.find((t) => t.includes('to DDS'));
  });
  await check('Optimize Textures panel', async () => {
    await vscode.commands.executeCommand('gtaPreview.optimizeTextures');
    await sleep(1000);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    if (!tabs.some((t) => t.startsWith('Optimize textures'))) throw new Error(`tabs: ${tabs}`);
    return tabs.find((t) => t.startsWith('Optimize textures'));
  });
  writeFileSync(process.env.GTA_TEST_OUT!, JSON.stringify(results, null, 2));
}
