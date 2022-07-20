import { getArchivePart } from '@yarnpkg/fslib/lib/ZipOpenFS';
import * as vscode from 'vscode';
import * as path from 'path';

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

	private refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	rootUri: Entry | undefined;

	async setRootUri(rootUri: Entry) {
		const short = await getShourtcut(rootUri);
		this.rootUri = short;
		this.refresh();
		return short;
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
				: vscode.TreeItemCollapsibleState.None
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
		const defTitle = treeView.title;
		context.subscriptions.push(treeView);
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(async (editor) => {
				if (editor) {
					const uri = editor.document.uri;
					if (uri.scheme === 'zip') {
						const zipFilePath = getArchivePart(uri.fsPath, '.zip');
						if (!zipFilePath) {
							console.log('not zip path..'); //handle unplugged??
							return;
						}
						const zipUri = uri.with({ path: zipFilePath });
						if (treeDataProvider.getRootUri()?.toString() !== zipUri.toString()) {
							const urlSet = await treeDataProvider.setRootUri(zipUri);
							const packageJson = vscode.Uri.joinPath(urlSet, 'package.json');
							treeView.title = defTitle;
							treeView.description = '';
							try {
								const content = await vscode.workspace.fs.readFile(packageJson); //mb get from registry instead
								const { name, version } = JSON.parse(
									Buffer.from(content).toString('utf-8')
								);
								treeView.title = name;
								treeView.description = version;
							} catch {}
						}
						const hasSelectedUri = treeView.selection.some(
							(u) => u.toString() === uri.toString()
						);
						if (!hasSelectedUri) {
							treeView.reveal(uri, { focus: true, select: true, expand: true });
						}
					}
				}
			})
		);
	}
}
