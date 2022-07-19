import * as path from 'path';
import { structUtils } from '@yarnpkg/core';
import { scoreFuzzy, FuzzyScore } from './fuzzy';
import * as vscode from 'vscode';
import * as child from 'child_process';

interface YarnInfoItem {
	value: Locator;
	children: {
		Version: string;
		Dependencies?: Array<{ locator: Locator }>;
	};
}

interface YarnPnpItem {
	name: string;
	reference: string;
	packageLocation: string;
}

type Locator = { __brand: 'locator' };
// type LocatorHash = { __brand: 'locatorHash' };
type LocatorHash = Locator;
const castLocatorToStr = (locator: Locator) => locator as any as string;
const castStrToLocatorHash = (str: string) => str as any as LocatorHash;

function debounce<A extends any[], R>(fn: (...args: A) => void, ms: number) {
	let prev: any;
	return (...args: A) => {
		if (prev !== undefined) {
			clearTimeout(prev);
		}
		prev = setTimeout(() => {
			prev = undefined;
			return fn(...args);
		}, ms);
	};
}

class DepMap {
	private map = new Map<LocatorHash, Set<LocatorHash>>();
	add(key: LocatorHash, el: LocatorHash) {
		if (!this.map.has(key)) {
			this.map.set(key, new Set<LocatorHash>());
		}
		this.map.get(key)!.add(el);
	}
	getAll(key: LocatorHash) {
		const res: LocatorHash[] = [];
		let toVisit = [key];
		const visited = new Set<LocatorHash>();
		while (toVisit.length) {
			const cur = toVisit.pop()!;
			if (visited.has(cur)) {
				continue;
			}
			visited.add(cur);
			const deps = this.get(cur);
			toVisit.push(...deps);
			res.push(...deps);
		}
		return res;
	}
	get(key: LocatorHash) {
		const d = this.map.get(key);
		if (d) {
			return [...d.keys()];
		}
		return [];
	}
	keys = this.map.keys.bind(this.map);
}

class Registry {
	constructor(
		readonly data: {
			depMap: DepMap;
			reverseMap: DepMap;
			locationMap: Map<LocatorHash, string>;
		}
	) {}
}

function prepareQuery(query: string) {
	return query.split('>').map((s) => s.replace(/ /g, ''));
}

interface ScoreData {
	name: Locator;
	score: FuzzyScore;
}

// function recScoreForName(queryList: string[], dep: string) {
// 	let totalScore = 0
// 	for (const query of queryList) {
// 		const score = scoreFuzzy(dep, query, query.toLowerCase(), true)[0];
// 		if (!score) {
// 			break
// 		}
// 		totalScore += score //mb incr coef
// 	}
// }

function scoreForArr(query: string, items: IterableIterator<Locator>) {
	const scores: Array<ScoreData> = [];
	for (const name of items) {
		const sc = scoreFuzzy(castLocatorToStr(name), query, query.toLowerCase(), true);
		if (sc[0] > 0) {
			scores.push({ name, score: sc });
		}
	}
	scores.sort((a, b) => {
		return b.score[0] - a.score[0];
	});
	return scores;
}

// interface ToProcess {
// 	name: Locator;
// 	parent: ScoreData | null;
// }

interface Result {
	name: Locator;
	path: Locator[];
}

function getParentsOrStop(registry: Registry, item: Locator[]) {
	if (item.length > 30) {
		// item.unshift('???') //todo
		return false;
	}
	const parents = registry.data.reverseMap.get(item[0]);
	if (!parents.length) {
		// item.unshift('???') //todo
		return false;
	}
	const desc = structUtils.parseDescriptor(castLocatorToStr(item[0]), true);

	const range = structUtils.parseRange(desc.range);
	if (range.protocol === 'workspace:') {
		return false;
	}
	let more: Locator[][] = [];
	for (const par of parents) {
		if (!item.includes(par)) {
			//avoid cycles, change to set?
			more.push([par, ...item]);
		}
	}
	return more;
}

function* getParentsRoutes(registry: Registry, locator: Locator) {
	const hardLimit = 100;
	let yielded = 0;
	const toProcess: Locator[][] = [[locator]];
	while (toProcess.length && yielded < hardLimit) {
		const item = toProcess.shift()!;

		const mbParents = getParentsOrStop(registry, item);
		if (mbParents) {
			toProcess.push(...mbParents);
		} else {
			item.pop(); //rm start dep
			yield item;
		}
	}
}

function limitAndArray<T>(lim: number, gen: IterableIterator<T> | T[]) {
	const res: T[] = [];

	for (let val of gen) {
		if (res.length >= lim) {
			break;
		}
		res.push(val);
	}
	return res;
}

const TOTAL_LIMIT = 100;

interface InWork {
	name: Locator;
	curScore: number;
	parentsGen: Generator<Locator[], void, unknown>;
	lastPath: Locator[];
}

function getPath(parentsGen: InWork['parentsGen']): Locator[] | null {
	const next = parentsGen.next();
	if (next.done || !next.value) {
		return null;
	}
	return next.value;
}

function adjustScore(inw: InWork) {
	const DEPTH_K = 1;
	inw.curScore = inw.curScore - inw.lastPath.length * DEPTH_K;
}

function insertWork(inWork: InWork[], item: InWork) {
	//todo
	inWork.push(item);
	inWork.sort((a, b) => {
		return a.curScore - b.curScore;
	});
}

function* getSearchRes(registry: Registry, query: string): Generator<Result> {
	const scores = limitAndArray(
		TOTAL_LIMIT,
		scoreForArr(query, registry.data.depMap.keys())
	);

	const inWork = scores.map<InWork>((scoreData) => {
		const parentsGen = getParentsRoutes(registry, scoreData.name);

		const inw: InWork = {
			name: scoreData.name,
			parentsGen,
			lastPath: getPath(parentsGen)!, //todo check
			curScore: scoreData.score[0],
		};

		adjustScore(inw);
		return inw;
	});

	inWork.sort((a, b) => {
		return a.curScore - b.curScore;
	});

	while (inWork.length) {
		const top = inWork.pop()!;

		yield {
			name: top.name,
			path: top.lastPath,
		};
		const newLastPath = getPath(top.parentsGen);

		if (newLastPath) {
			top.lastPath = newLastPath;
			adjustScore(top);
			insertWork(inWork, top);
		}
	}
}

function descToLabel(locator: Locator) {
	const depd = structUtils.parseDescriptor(castLocatorToStr(locator), true);
	const label = structUtils.stringifyIdent(depd);
	const ran = structUtils.parseRange(depd.range);
	//todo protocols
	return { label, description: ran.selector };
}

interface MyQuickPickItem extends vscode.QuickPickItem {
	_locator: Locator;
	_location: string | undefined;
}

async function* splitByNewline(gen: AsyncGenerator<string, void>) {
	let soFar: string | undefined = undefined;

	for await (const data of gen) {
		const parts: string[] = ((soFar ?? '') + data).split(/\r?\n/);
		soFar = parts.pop();

		for (const part of parts) {
			yield part;
		}
	}
}

async function* iterMap<T, R>(gen: AsyncGenerator<T, void>, mapper: (val: T) => R) {
	for await (const val of gen) {
		yield mapper(val);
	}
}

const pnpScript = `const mod = require('module');
const pnpapi = mod.findPnpApi(process.cwd());

for (const locator of pnpapi.getAllLocators()) {
    const info = pnpapi.getPackageInformation(locator);
    const data = {
        name: locator.name,
        reference: locator.reference,
        packageLocation: info.packageLocation   
    }
    process.stdout.write(JSON.stringify(data)+'\\n')
}`;

async function* runProcess(cwd: string, cmd: string, args: string[]) {
	const pr = child.spawn(cmd, args, {
		cwd,
	});
	for await (const data of pr.stdout) {
		yield data.toString('utf8');
	}

	pr.stderr.on('data', (data) => {
		console.log(data.toString('utf8'));
	});

	pr.on('close', (code) => {
		console.log(`child process exited with code ${code}`);
	});
}

function runJsondCommand<T>(cwd: string, cmd: string, args: string[]) {
	return iterMap(splitByNewline(runProcess(cwd, cmd, args)), (val) => JSON.parse(val) as T);
}

async function getPnpData(projectRoot: string) {
	const locationMap = new Map<LocatorHash, string>();

	const pnpData = runJsondCommand<YarnPnpItem>(projectRoot, 'node', [
		'-r',
		path.join(projectRoot, '.pnp.cjs'),
		'-e',
		pnpScript,
	]);

	for await (const item of pnpData) {
		const locator = structUtils.makeLocator(
			structUtils.parseIdent(item.name),
			item.reference
		);
		const locatorStr = castStrToLocatorHash(structUtils.stringifyLocator(locator));
		locationMap.set(locatorStr, item.packageLocation);
	}
	return { locationMap };
}

async function getProjectData(projectRoot: string) {
	const depMap = new DepMap();
	const reverseMap = new DepMap();
	const data = runJsondCommand<YarnInfoItem>(projectRoot, 'yarn', [
		'info',
		'-A',
		'-R',
		'--json',
	]);

	for await (const item of data) {
		const itemLoc = structUtils.parseLocator(castLocatorToStr(item.value), true);
		// if (structUtils.isVirtualDescriptor(d)) {
		for (const _dep of item.children.Dependencies ?? []) {
			let depd = structUtils.parseLocator(castLocatorToStr(_dep.locator), true);
			if (structUtils.isVirtualLocator(depd)) {
				depd = structUtils.devirtualizeLocator(depd);
			}
			// const depname = structUtils.stringifyIdent(depd);

			const depLoc = castStrToLocatorHash(structUtils.stringifyLocator(depd));
			depMap.add(item.value, depLoc);
			reverseMap.add(depLoc, item.value);
		}
	}
	return { reverseMap, depMap };
}
async function createRegistry(projectRoot: string) {
	const [projectData, pnpData] = await Promise.all([
		getProjectData(projectRoot),
		getPnpData(projectRoot),
	]);
	const registry = new Registry({
		...projectData,
		...pnpData,
	});

	return registry;
}

export async function activateSearch(context: vscode.ExtensionContext) {
	const qp = vscode.window.createQuickPick<MyQuickPickItem>();
	context.subscriptions.push(qp);

	let workspace: vscode.WorkspaceFolder | undefined;

	if (vscode.workspace.workspaceFolders) {
		if (vscode.workspace.workspaceFolders.length > 1) {
			workspace = await vscode.window.showWorkspaceFolderPick();
		} else {
			workspace = vscode.workspace.workspaceFolders[0];
		}
	}
	if (!workspace) {
		vscode.window.showErrorMessage(`Can't find workspace`);
		return;
	}
	let regLoaded = false;
	const _registry = createRegistry(workspace.uri.path);
	_registry.finally(() => {
		regLoaded = true;
	});

	const awaitRegistry = async () => {
		if (regLoaded) {
			return _registry;
		}
		qp.busy = true;
		const reg = await _registry;
		qp.busy = false;
		return reg;
	};

	let searchTok: vscode.CancellationTokenSource | undefined;

	qp.onDidAccept(() => {
		searchTok?.cancel();
		if (!qp.selectedItems[0]) {
			return;
		}
		const _location = qp.selectedItems[0]._location;
		if (!_location) {
			vscode.window.showErrorMessage("Can't find location");
			return;
		}
		const fileLoc = path.join(_location, 'package.json');
		const zipUri = vscode.Uri.parse(`zip:${fileLoc}`);
		vscode.window.showTextDocument(zipUri);
		qp.hide();
		qp.dispose();
	});
	qp.ignoreFocusOut = true;

	const makeSarchTok = () => {
		const tok = new vscode.CancellationTokenSource();
		context.subscriptions.push(tok);
		return tok;
	};

	const makeSearch = async (query: string) => {
		searchTok?.cancel();
		searchTok = makeSarchTok();

		const registry = await awaitRegistry();
		if (searchTok.token.isCancellationRequested) {
			return;
		}
		const res = limitAndArray(TOTAL_LIMIT, getSearchRes(registry, query));

		qp.items = res.map<MyQuickPickItem>((r, ind) => {
			const { label, description } = descToLabel(r.name);
			const detail = r.path.map((n) => descToLabel(n).label).join(' > ');
			const _location = registry.data.locationMap.get(r.name);

			return {
				label,
				description,
				detail,
				alwaysShow: true,
				_locator: r.name,
				_location,
			};
		});
	};

	qp.onDidHide(() => {
		searchTok?.cancel();
	});
	qp.onDidChangeValue(debounce(makeSearch, 300));
	qp.show();
}
