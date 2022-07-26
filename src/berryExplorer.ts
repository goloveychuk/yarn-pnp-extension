import { getArchivePart } from '@yarnpkg/fslib/lib/ZipOpenFS';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import clipboard from 'clipboardy';

type Entry = vscode.Uri;

async function mbGetOneDir(uri: vscode.Uri): Promise<null | vscode.Uri> {
  const files = await vscode.workspace.fs.readDirectory(uri);
  if (files.length === 1 && files[0][1] === vscode.FileType.Directory) {
    return vscode.Uri.joinPath(uri, files[0][0]);
  }
  return null;
}

async function getShourtcut(uri: vscode.Uri) {
  let cur: vscode.Uri | null = uri;
  let shorted = uri;
  while (cur) {
    shorted = cur;
    cur = await mbGetOneDir(cur);
  }
  return shorted;
}

export class BerryProvider implements vscode.TreeDataProvider<Entry> {
  private _onDidChangeTreeData: vscode.EventEmitter<Entry | undefined | void> =
    new vscode.EventEmitter<Entry | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<Entry | undefined | void> =
    this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  rootUri: Entry | undefined;
  _realuri: Entry | undefined;

  async setRootUri(rootUri: Entry) {
    this._realuri = rootUri;
    const short = await getShourtcut(rootUri);
    this.rootUri = short;
    this.refresh();
    return short;
  }
  clearUri() {
    this._realuri = undefined;
    this.rootUri = undefined;
	this.refresh()
  }

  getRootUri() {
    return this.rootUri;
  }

  async getTreeItem(uri: Entry) {
    const { type } = await vscode.workspace.fs.stat(uri);

    const treeItem = new vscode.TreeItem(
      uri,
      type === vscode.FileType.Directory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    if (type === vscode.FileType.Directory) {
      // treeItem.label = 'label'
      // treeItem.tooltip = 'on hover';
      // treeItem.description = '1.2.2';
    }
    if (type === vscode.FileType.File) {
      treeItem.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [uri],
      };
      treeItem.contextValue = 'file';
    }
    return treeItem;
  }

  getParent(uri: Entry): vscode.ProviderResult<Entry> {
    if (!this.rootUri) {
      // should not be called
      return null;
    }
    const parent = uri.with({ path: path.dirname(uri.path) });
    if (parent.fsPath === this.rootUri.fsPath) {
      return null;
    }
    return parent;
  }

  async getChildren(_uri?: Entry): Promise<Entry[]> {
    const uri = _uri ?? this.rootUri;

    if (!uri) {
      return [];
    }
    const children = await vscode.workspace.fs.readDirectory(uri);
    children.sort((a, b) => {
      if (a[1] === b[1]) {
        return a[0].localeCompare(b[0]);
      }
      return a[1] === vscode.FileType.Directory ? -1 : 1;
    });

    return children.map(([name, type]) => vscode.Uri.joinPath(uri, name));
  }
}

export class BerryExplorer {
  constructor(context: vscode.ExtensionContext) {
    const treeDataProvider = new BerryProvider();
    const treeView = vscode.window.createTreeView('yarnBerryExplorer', {
      treeDataProvider,
    });
    vscode.commands.registerCommand('yarnBerryResolve.delete', async (uri) => {
      // let all  =await  vscode.commands.getCommands();
      // await vscode.commands.executeCommand('deleteFile', uri)
      // await vscode.workspace.fs.delete(uri)
      // debugger
    });
    vscode.commands.registerCommand('yarnBerryResolve.mount', async () => {
      await vscode.commands.executeCommand(
        'zipfs.mountZipFile',
        treeDataProvider._realuri,
      );
    });
	vscode.commands.registerCommand('yarnBerryResolve.refresh', () => {
		treeDataProvider.refresh()
	});
	// vscode.commands.registerCommand('yarnBerryResolve.copyArchPath', () => {
	// 	if (treeDataProvider._realuri) {
	// 		clipboard.writeSync(treeDataProvider._realuri.fsPath)
	// 	}
	// });
    vscode.commands.registerCommand('yarnBerryResolve.removeArch', async () => {
      if (treeDataProvider._realuri) {
        const uri = treeDataProvider._realuri;
        const res = await vscode.window.showInformationMessage(
          `Do you want to remove archive file?`,
		  {modal: true, detail: uri.fsPath},
          'Remove',
        );
        if (res === 'Remove') {
          treeDataProvider.clearUri();
          fs.rmSync(uri.fsPath);
        }
      }
    });
    const defTitle = treeView.title;
    context.subscriptions.push(treeView);
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor) {
          const uri = editor.document.uri;
          treeView.reveal;
          if (uri.scheme === 'zip') {
            const zipFilePath = getArchivePart(uri.fsPath, '.zip');
            if (!zipFilePath) {
              console.log('not zip path..'); //handle unplugged??
              return;
            }
            const zipUri = uri.with({ path: zipFilePath });
            if (
              treeDataProvider.getRootUri()?.toString() !== zipUri.toString()
            ) {
              const urlSet = await treeDataProvider.setRootUri(zipUri);
              const packageJson = vscode.Uri.joinPath(urlSet, 'package.json');
              treeView.title = defTitle;
              treeView.description = '';
              try {
                const content = await vscode.workspace.fs.readFile(packageJson); //mb get from registry instead
                const { name, version } = JSON.parse(
                  Buffer.from(content).toString('utf-8'),
                );
                treeView.title = name;
                treeView.description = version;
              } catch {}
            }
            const hasSelectedUri = treeView.selection.some(
              (u) => u.toString() === uri.toString(),
            );
            if (!hasSelectedUri) {
              treeView.reveal(uri, { focus: true, select: true, expand: true });
            }
          }
        }
      }),
    );
  }
}
