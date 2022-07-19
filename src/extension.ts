import * as vscode from 'vscode';

import { BerryExplorer } from './berryExplorer';
import { activateSearch } from './resolve';

export function activate(context: vscode.ExtensionContext) {
	new BerryExplorer(context);

	vscode.commands.registerCommand('yarnBerryResolve.openResolve', async () => {
		await activateSearch(context);
	});
}
