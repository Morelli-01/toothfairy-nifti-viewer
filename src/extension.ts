import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { datasetLabelNames } from './volume-utils';

const VIEW_TYPE = 'toothfairyNifti.volumeViewer';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new NiftiEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('toothfairyNifti.open', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri ?? (await vscode.window.showOpenDialog({
        canSelectMany: false, filters: { 'NIfTI volumes': ['nii', 'nii.gz'] },
      }))?.[0];
      if (!target) {
        void vscode.window.showInformationMessage('Select a .nii or .nii.gz file first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

export function deactivate(): void {}

class NiftiEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const directory = vscode.Uri.joinPath(document.uri, '..');
    const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri) ?? [];
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [directory, this.context.extensionUri, ...workspaceRoots],
    };

    const messageSubscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object' || (message as { type?: string }).type !== 'selectMask') return;
      const selected = await vscode.window.showOpenDialog({
        canSelectMany: false,
        defaultUri: directory,
        filters: { 'NIfTI segmentation masks': ['nii', 'nii.gz'] },
        openLabel: 'Load segmentation mask',
      });
      const mask = selected?.[0];
      if (!mask) return;
      const allowedRoots = [directory, ...workspaceRoots];
      const allowed = allowedRoots.some(root => {
        const relative = path.relative(root.fsPath, mask.fsPath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      });
      if (!allowed) {
        void vscode.window.showErrorMessage('The mask must be inside the current workspace or beside the open volume.');
        return;
      }
      await panel.webview.postMessage({
        type: 'maskSelected',
        uri: panel.webview.asWebviewUri(mask).toString(),
        filename: path.basename(mask.fsPath),
        labelNames: await findLabelNames(vscode.Uri.joinPath(mask, '..')),
      });
    });
    panel.onDidDispose(() => messageSubscription.dispose());

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.css'),
    );
    const volumeUri = panel.webview.asWebviewUri(document.uri);
    const nonce = createNonce();

    panel.webview.html = getHtml({
      scriptUri,
      styleUri,
      volumeUri,
      filename: path.basename(document.uri.fsPath),
      labelNames: await findLabelNames(directory),
      nonce,
      cspSource: panel.webview.cspSource,
    });
  }
}

function getHtml(options: {
  scriptUri: vscode.Uri;
  styleUri: vscode.Uri;
  volumeUri: vscode.Uri;
  filename: string;
  labelNames: Record<number, string> | null;
  nonce: string;
  cspSource: string;
}): string {
  const { scriptUri, styleUri, volumeUri, nonce, cspSource } = options;
  const filename = escapeHtml(options.filename);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${cspSource}; worker-src blob:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>${filename}</title>
</head>
<body>
  <main id="app" data-volume-uri="${volumeUri}" data-filename="${filename}" data-label-names="${escapeHtml(JSON.stringify(options.labelNames))}">
    <div id="viewport" aria-label="Interactive 3D NIfTI volume">
      <canvas id="slice-axial" class="slice" aria-label="Axial slice"></canvas>
      <canvas id="slice-coronal" class="slice" aria-label="Coronal slice"></canvas>
      <canvas id="slice-sagittal" class="slice" aria-label="Sagittal slice"></canvas>
      <div id="view3d"></div>
    </div>
    <section id="controls" aria-label="Volume rendering controls">
      <header>
        <div class="file-info">
          <strong>${filename}</strong>
          <span id="metadata">Loading NIfTI volume…</span>
        </div>
        <div class="view-actions">
          <select id="orientation" aria-label="Voxel orientation" title="How voxel axes i, j, k map to patient directions: the header transform, the raw voxel grid, or a standard orientation code assigned to i·j·k">
            <option value="header">Header</option>
            <option value="raw">Raw voxels</option>
          </select>
          <button id="layout-toggle" type="button" aria-pressed="false" title="Switch between the 3D view and four panels: axial, coronal, sagittal and 3D">Four-up</button>
          <button id="axial-camera" type="button">Axial</button>
          <button id="reset-camera" type="button">Reset 3D</button>
        </div>
      </header>
      <div class="control-grid">
        <label class="style-control">3D view
          <select id="render-style">
            <option value="mip">MIP</option>
            <option value="amip" selected>Attenuated MIP</option>
            <option value="iso">Isosurface</option>
          </select>
        </label>
        <label>Level <output id="level-value">–</output>
          <input id="level" type="range" min="0" max="1000" value="500" step="1">
        </label>
        <label>Window <output id="window-value">–</output>
          <input id="window" type="range" min="1" max="1000" value="1000" step="1">
        </label>
        <label id="threshold-label" hidden>Threshold <output id="threshold-value">35%</output>
          <input id="threshold" type="range" min="1" max="99" value="35" step="1">
        </label>
        <button id="reset-contrast" class="contrast-reset" type="button">Reset contrast</button>
      </div>
      <div class="segmentation-tools">
        <label>Display
          <select id="display-mode">
            <option value="cbct">CBCT</option>
            <option value="mask">Mask only</option>
            <option value="overlay">CBCT + mask</option>
          </select>
        </label>
        <button id="load-mask" type="button">Load mask…</button>
        <span id="mask-name">No external mask</span>
        <label id="mask-opacity-label">Mask opacity <output id="mask-opacity-value">65%</output>
          <input id="mask-opacity" type="range" min="5" max="100" value="65" step="1">
        </label>
      </div>
      <p class="help">3D: drag to rotate · right-drag to pan · scroll to zoom · Slices: click or drag to move the crosshair · scroll to change slice</p>
    </section>
    <aside id="mask-legend" aria-label="Segmentation labels" hidden>
      <div class="legend-head">
        <span class="legend-title">Labels</span>
        <span id="legend-count"></span>
        <button id="legend-collapse" type="button" aria-expanded="true" aria-controls="legend-body" title="Collapse or expand the label list">▾</button>
      </div>
      <div id="legend-body" class="legend-body">
        <input id="legend-filter" type="search" placeholder="Filter: number or name (e.g. pulp, lower left)" aria-label="Filter labels">
        <div class="legend-actions">
          <button id="legend-all" type="button" title="Show every listed label">Show all</button>
          <button id="legend-none" type="button" title="Hide every listed label">Hide all</button>
          <button id="legend-invert" type="button" title="Invert visibility of every listed label">Invert</button>
        </div>
        <div id="legend-labels" class="legend-labels"></div>
      </div>
    </aside>
    <div id="loading"><span class="spinner"></span><span id="loading-message">Reading volume…</span></div>
    <div id="error" role="alert" hidden></div>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Class names from the nearest dataset.json in `directory` or up to three folders above it. */
async function findLabelNames(directory: vscode.Uri): Promise<Record<number, string> | null> {
  for (let depth = 0; depth < 4; depth++, directory = vscode.Uri.joinPath(directory, '..')) {
    try {
      const file = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, 'dataset.json'));
      const names = datasetLabelNames(JSON.parse(new TextDecoder().decode(file))?.labels);
      if (names) return names;
    } catch {
      // Missing or unreadable: keep walking up.
    }
  }
  return null;
}

function createNonce(): string {
  return randomBytes(24).toString('hex');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character);
}
