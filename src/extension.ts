import path from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { Blame, getBlames, getChanges, getEmptyTree, getFileStatus, getGitRepository, getParentCommitId, getRepoWebBase, buildCommitUrl } from './git';
import { buildUncommitBlame, formatDate, getCommitColor, getTextWidth, resolveChange, toMultiFileDiffEditorUris, trancateText } from './utils'
import type { DateFormatStyle } from './utils';

// 全局状态
const fileBlameStates = new Map<string, boolean>();
const fileDecorations = new Map<string, {
    decorationTypes: vscode.TextEditorDecorationType[] | undefined,
    decorationOptions: vscode.DecorationOptions[][] | undefined,
    hoverProvider: vscode.Disposable | undefined,
    blames: Blame[] | undefined,
    lineBlames: Map<number, Blame> | undefined,
    highlightDecorationType: vscode.TextEditorDecorationType | undefined,
}>();


interface BlameDisplayConfig {
    mergeCommitLines: boolean;
    dateFormatStyle: DateFormatStyle
}

const MaxTitleWidth = 25;
const VALID_FORMATS: DateFormatStyle[] = ['YYYY-MM-DD', 'Y/M/D', 'DD.MM.YYYY', 'relative'];

/**
* 激活插件
*/
export function activate(context: vscode.ExtensionContext) {
    registerCommands(context);
    registerListeners(context);
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        updateMenuContext(editor.document);
    }

    // Dev-only: auto-reload extension host when compiled output changes
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(context.extensionUri, 'out/**/*.js')
        );
        watcher.onDidChange(() => {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
        context.subscriptions.push(watcher);
    }
}

/**
* 卸载插件
*/
export function deactivate() {
    for (const [_, decorations] of fileDecorations) {
        decorations.decorationTypes?.forEach(type => type.dispose());
        decorations.hoverProvider?.dispose();
        decorations.highlightDecorationType?.dispose();
    }
    fileDecorations.clear();
    fileBlameStates.clear();
}


/**
* 注册命令
*/
function registerCommands(context: vscode.ExtensionContext) {

    // Toggle blame annotations
    const toggleCommand = vscode.commands.registerCommand('git.blame.toggle', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const document = editor.document;
            const documentUri = document.uri.toString();
            const fileBlameState = fileBlameStates.get(documentUri) || false;
            if (!fileBlameState) {
                const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === documentUri);
                const successed = await showDecorations(editors);
                if (successed) {
                    updateMenuContext(document, true);
                }
            } else {
                const successed = await hideDecorations(document);
                if (successed) {
                    updateMenuContext(document, false);
                }
            }
        }
    });

    // Show blame annotations
    const showCommand = vscode.commands.registerCommand('git.blame.show', async (event?: any) => {
        const documentUri = (event?.uri || vscode.window.activeTextEditor?.document.uri)?.toString() || "";
        if (documentUri) {
            const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === documentUri);
            if (editors.length > 0) {
                const successed = await showDecorations(editors);
                if (successed) {
                    updateMenuContext(editors[0].document, true);
                }
            }
        }
    });

    // Hide blame annotations
    const hideCommand = vscode.commands.registerCommand('git.blame.hide', async (event?: any) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const successed = await hideDecorations(editor.document);
            if (successed) {
                updateMenuContext(editor.document, false);
            }
        }
    });

    // View commit details
    const viewCommitCommand = vscode.commands.registerCommand('git.blame.viewCommit', async (commitId: string, summary: string = "", fileName: string = "") => {
        if (fileName) {
            const repositoryRoot = await getGitRepository(fileName);
            const title = `${commitId.substring(0, 7)} ${summary ? `- ${summary.substring(0, 20)}` : ""}`;
            let parentCommitId = await getParentCommitId(repositoryRoot, commitId);
            if (!parentCommitId) {
                parentCommitId = await getEmptyTree(repositoryRoot);
            }
            const multiDiffSourceUri = Uri.from({ scheme: 'scm-history-item', path: `${repositoryRoot}/${parentCommitId}..${commitId}` });
            const changes = await getChanges(repositoryRoot, parentCommitId, commitId);
            const resources = changes.map(c => toMultiFileDiffEditorUris(c, parentCommitId, commitId));

            await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', { multiDiffSourceUri, title, resources });
        }
    });
    context.subscriptions.push(toggleCommand, showCommand, hideCommand, viewCommitCommand);
}

/**
* 注册事件
*/
function registerListeners(context: vscode.ExtensionContext) {

    // Editor Change
    const editorChangeSubscription = vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            updateMenuContext(editor.document);
        }
    });

    const visibleEditorChangeSubscription = vscode.window.onDidChangeVisibleTextEditors(editors => {
        for (const editor of editors) {
            const fileBlameState = fileBlameStates.get(editor.document.uri.toString());
            if (fileBlameState) {
                showDecorations([editor]);
            }
        }
    });

    // Document Close
    const closeDocumentSubscription = vscode.workspace.onDidCloseTextDocument(document => {
        const documentUri = document.uri.toString();
        fileBlameStates.delete(documentUri);
        const decorations = fileDecorations.get(documentUri);
        if (decorations) {
            fileDecorations.delete(documentUri);
            decorations.decorationTypes?.forEach(type => type.dispose());
            decorations.hoverProvider?.dispose();
            decorations.highlightDecorationType?.dispose();
        }
    });

    // Document Save
    const saveDocumentSubscription = vscode.workspace.onDidSaveTextDocument(async document => {
        const documentUri = document.uri.toString();
        const fileBlameState = fileBlameStates.get(documentUri);
        if (fileBlameState) {
            const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === documentUri);
            if (editors.length > 0) {
                await showDecorations(editors, true);
            }
        }
    });

    // Document change
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(async (event) => {
        const documentUri = event.document.uri.toString();
        const isNeedUpdate = event.contentChanges.length > 0 && fileBlameStates.get(documentUri);
        if (isNeedUpdate) {
            const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === documentUri);
            if (editors.length > 0) {
                await updateDecorationsOnChange(editors, event);
            }
        }
    });

    // Highlight all lines of the commit under the cursor
    const selectionChangeSubscription = vscode.window.onDidChangeTextEditorSelection(event => {
        const editor = event.textEditor;
        const uri = editor.document.uri.toString();
        if (!fileBlameStates.get(uri)) { return; }
        const state = fileDecorations.get(uri);
        if (!state) { return; }

        if (!state.highlightDecorationType) {
            state.highlightDecorationType = vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: "rgba(0, 188, 242, 0.2)"
            });
        }

        const lineIdx = event.selections[0].active.line;
        const blame = state.lineBlames?.get(lineIdx);

        if (!blame?.commited) {
            editor.setDecorations(state.highlightDecorationType, []);
            return;
        }

        const ranges = state.blames
            ?.map((b, i) => b.commit === blame.commit ? new vscode.Range(i, 0, i, 0) : null)
            .filter((r): r is vscode.Range => r !== null) ?? [];
        editor.setDecorations(state.highlightDecorationType, ranges);
    });

    context.subscriptions.push(
        editorChangeSubscription, visibleEditorChangeSubscription, closeDocumentSubscription,
        saveDocumentSubscription, changeDocumentSubscription, selectionChangeSubscription
    );
}

/**
* 显示装饰器
*/
async function showDecorations(editors: vscode.TextEditor[], reload: boolean = false): Promise<boolean> {
    const document = editors[0].document;
    const documentUri = document.uri.toString();
    let decorations = fileDecorations.get(documentUri);

    // Skip diff editor
    if (document.uri.scheme !== 'file') {
        return false;
    }

    // Use cache
    if (!reload && decorations && decorations.decorationTypes && decorations.decorationOptions) {
        for (const editor of editors) {
            const decorationNum = Math.min(decorations.decorationTypes.length, decorations.decorationOptions.length);
            for (let i = 0; i < decorationNum; i++) {
                editor.setDecorations(decorations.decorationTypes[i], decorations.decorationOptions[i]);
            }
        }
        fileBlameStates.set(documentUri, true);
        return true;
    }

    if (!decorations) {
        decorations = {
            decorationTypes: undefined,
            decorationOptions: undefined,
            hoverProvider: undefined,
            blames: undefined,
            lineBlames: undefined,
            highlightDecorationType: undefined,
        };

        fileDecorations.set(documentUri, decorations);
    }

    try {
        // Blames
        const blames = await getBlames(path.dirname(document.fileName), document.fileName);
        for (let i = blames.length; i < document.lineCount; i++) {
            blames.push(buildUncommitBlame(i + 1));
        }

        // Repo web base for commit links
        const repositoryRoot = await getGitRepository(document.fileName);
        const repoWebBase = repositoryRoot ? await getRepoWebBase(repositoryRoot) : "";

        // Decorations
        if (!decorations.decorationTypes) {
            decorations.decorationTypes = [];
        }

        decorations.decorationOptions = buildDecorationOptions(blames, document.fileName, repoWebBase);
        for (const editor of editors) {
            const decorationNum = decorations.decorationOptions.length;
            for (let i = 0; i < decorationNum; i++) {
                if (i >= decorations.decorationTypes.length) {
                    decorations.decorationTypes.push(vscode.window.createTextEditorDecorationType({}));
                }
                editor.setDecorations(decorations.decorationTypes[i], decorations.decorationOptions[i]);
            }
        }
        decorations.blames = blames;
        decorations.lineBlames = new Map(blames.map((blame, index) => [index, blame]));
        decorations.hoverProvider?.dispose();
        decorations.hoverProvider = undefined;
        fileBlameStates.set(documentUri, true);
        return true;
    } catch (error: any) {
        if (!error.message.includes("code 128")) {
            vscode.window.showErrorMessage(`${error.message}`);
        }
        return false;
    }
}



/**
* 隐藏装饰器
*/
async function hideDecorations(document: vscode.TextDocument): Promise<boolean> {
    const documentUri = document.uri.toString();
    fileBlameStates.set(documentUri, false);
    let decorations = fileDecorations.get(documentUri);
    if (decorations) {
        fileDecorations.delete(documentUri);
        decorations.decorationTypes?.forEach(type => type.dispose());
        decorations.hoverProvider?.dispose();
        decorations.highlightDecorationType?.dispose();
        return true;
    }
    return false;
}

/**
* 更新装饰器
*/
async function updateDecorationsOnChange(editors: vscode.TextEditor[], event: vscode.TextDocumentChangeEvent) {
    const documentUri = editors[0].document.uri.toString();
    const decorations = fileDecorations.get(documentUri);
    if (!decorations || !decorations.decorationTypes) {
        return;
    }
    const blames = fileDecorations.get(documentUri)?.blames;
    if (!blames) {
        return;
    }

    // resolve changes
    let shouldUpdate = false;
    for (const change of event.contentChanges) {
        const { addedLines, deletedLines, modifiedLines } = resolveChange(change);
        if (addedLines.length === 0 && deletedLines.length === 0 && modifiedLines.length === 0) {
            continue;
        }

        if (modifiedLines.length > 0) {
            for (let i = 0; i < modifiedLines.length; i++) {
                if (blames[modifiedLines[i]].commited) {
                    blames[modifiedLines[i]].commit = '0000000000000000000000000000000000000000';
                    blames[modifiedLines[i]].commited = false;
                    shouldUpdate = true;
                }
            }
        }

        if (deletedLines.length > 0) {
            shouldUpdate = true;
            for (let i = deletedLines.length - 1; i >= 0; i--) {
                blames.splice(deletedLines[i], 1);
            }
        }

        if (addedLines.length > 0) {
            shouldUpdate = true;
            for (let i = 0; i < addedLines.length; i++) {
                blames.splice(addedLines[i], 0, buildUncommitBlame(addedLines[i] + 1));
            }
        }
    }

    if (!shouldUpdate) {
        return;
    }

    const repositoryRoot = await getGitRepository(editors[0].document.fileName);
    const repoWebBase = repositoryRoot ? await getRepoWebBase(repositoryRoot) : "";

    // update decorations
    decorations.decorationOptions = buildDecorationOptions(blames, editors[0].document.fileName, repoWebBase);
    for (const editor of editors) {
        const decorationNum = decorations.decorationOptions.length;
        for (let i = 0; i < decorationNum; i++) {
            if (i >= decorations.decorationTypes.length) {
                decorations.decorationTypes.push(vscode.window.createTextEditorDecorationType({}));
            }

            editor.setDecorations(decorations.decorationTypes[i], decorations.decorationOptions[i]);
        }
    }

    decorations.blames = blames;
    decorations.lineBlames = new Map(blames.map((blame, index) => [index, blame]));
}

/**
* 更新上下文菜单
*/
async function updateMenuContext(document: vscode.TextDocument, currentState: boolean | undefined = undefined) {
    // Skip diff editor
    if (document.uri.scheme !== 'file') {
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', false);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', false);
        return;
    }

    if (currentState !== undefined) {
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', !currentState);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', currentState);
        return;
    }

    try {
        // check file tracked
        const fileStatus = await getFileStatus(path.dirname(document.fileName), document.fileName);
        const isTracked = fileStatus !== "untracked" && fileStatus !== "index_add";
        if (!isTracked) {
            vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', false);
            vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', false);
            return;
        }

        // check file blame state
        const fileBlameState = fileBlameStates.get(document.uri.toString());
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', !fileBlameState);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', fileBlameState);
    } catch (error) {
        // check git repository
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', false);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', false);
    }
}

function buildDecorationOptions(blames: Blame[], fileName: string, repoWebBase: string): vscode.DecorationOptions[][] {
    const cfg = vscode.workspace.getConfiguration('gitblame');

    const rawDateFormatStyle = cfg.get('dateFormatStyle', 'relative');
    const validDateFormatStyle = VALID_FORMATS.includes(rawDateFormatStyle as DateFormatStyle)
        ? (rawDateFormatStyle as DateFormatStyle)
        : 'relative';

    const config: BlameDisplayConfig = {
        mergeCommitLines: cfg.get('mergeCommitLines', true),
        dateFormatStyle: validDateFormatStyle
    };

    const maxWidth = fillTitles(blames, config);
    if (maxWidth <= 0) {
        return [];
    }

    const singleCommit = new Set(blames.filter(b => b.commited).map(b => b.commit)).size === 1;

    const decorationOptions: vscode.DecorationOptions[] = [];
    const decorationOptionsHeatmap: vscode.DecorationOptions[] = [];
    const colorsMap = new Map<string, { lightColor: string, darkColor: string }>();
    blames.forEach((blame, index) => {
        let color = colorsMap.get(blame.commit);
        if (!color) {
            color = getCommitColor(blame.commit, blame.timestamp);
            colorsMap.set(blame.commit, color);
        }

        const range = new vscode.Range(
            new vscode.Position(index, 0),
            new vscode.Position(index, 0)
        );
        const hoverMessage = buildHoverMessage(blame, fileName, repoWebBase);
        const option: vscode.DecorationOptions = {
            range,
            hoverMessage,
            renderOptions: {
                before: {
                    contentText: `\u2007${blame.title}\u2007`,
                    color: new vscode.ThemeColor('list.deemphasizedForeground'),
                    width: `${maxWidth + 2}ch`,
                    fontWeight: 'normal',
                    fontStyle: 'normal',
                }
            }
        };
        decorationOptions.push(option);

        const optionHeatmap: vscode.DecorationOptions = {
            range,
            hoverMessage,
            renderOptions: {
                before: {
                    contentText: '\u2007',
                    width: '2px',
                    margin: '0 25px 0 0',
                },
                light: {
                    before: {
                        backgroundColor: color.lightColor
                    }
                },
                dark: {
                    before: {
                        backgroundColor: color.darkColor
                    }
                }
            }
        };
        if (singleCommit || !blame.commited) {
            optionHeatmap.renderOptions!.light!.before!.backgroundColor = 'transparent';
            optionHeatmap.renderOptions!.dark!.before!.backgroundColor = 'transparent';
        }
        decorationOptionsHeatmap.push(optionHeatmap);
    });

    return [decorationOptions, decorationOptionsHeatmap];
}

function buildHoverMessage(blame: Blame, fileName: string, repoWebBase: string): vscode.MarkdownString | undefined {
    if (!blame.commited) {
        return undefined;
    }

    const rawStyle = vscode.workspace.getConfiguration('gitblame').get('dateFormatStyle', 'relative');
    const activeStyle: DateFormatStyle = VALID_FORMATS.includes(rawStyle as DateFormatStyle)
        ? (rawStyle as DateFormatStyle)
        : 'relative';
    const hoverStyle: DateFormatStyle = activeStyle === 'relative' ? 'YYYY-MM-DD' : activeStyle;
    const dateText = formatDate(blame.timestamp, hoverStyle);

    const content = new vscode.MarkdownString();
    const [commitUrl, gitPlatform] = buildCommitUrl(repoWebBase, blame.commit);
    if (commitUrl) {
        const viewText = gitPlatform ? `View on ${gitPlatform}` : 'Open in Browser';
        content.appendMarkdown(`[${viewText}](${commitUrl}) \n`);
    }

    content.appendMarkdown(`commit: [${blame.commit}](command:git.blame.viewCommit?${encodeURIComponent(JSON.stringify([blame.commit, blame.summary, fileName]))}) \n`);
    content.appendMarkdown(`Author: ${blame.author} \n`);
    content.appendMarkdown(`Date: ${dateText} \n`);
    if (blame.summary) {
        content.appendMarkdown(`\n\n${blame.summary}`);
    }

    content.isTrusted = true;
    return content;
}

function fillTitles(blames: Blame[], config: BlameDisplayConfig): number {
    let maxWidth = 0;

    // Compute per-line timestamp strings and the max width for alignment padding
    const lineTimestampText = new Map<number, string>();
    const maxTimestampWidth = blames.reduce((maxW, line) => {
        if (!line.commited) { return maxW; }
        const text = formatDate(line.timestamp, config.dateFormatStyle)
        lineTimestampText.set(line.line, text);
        return Math.max(maxW, text.length);
    }, 8);

    const textWidths = new Map<string, { width: number, widths: number[] }>();
    blames.forEach(line => {
        if (line.commited) {
            const tsText = (lineTimestampText.get(line.line) ?? '').padEnd(maxTimestampWidth, '\u2007');
            line.title = `${tsText} ${line.author}`
        } else {
            line.title = '';
        }

        if (!textWidths.has(line.commit)) {
            const { width, widths } = getTextWidth(line.title);
            textWidths.set(line.commit, { width, widths });
            if (width > maxWidth) { maxWidth = width; }
        }
    });

    if (maxWidth > MaxTitleWidth) {
        maxWidth = MaxTitleWidth;
        blames.forEach(line => {
            const { width, widths } = textWidths.get(line.commit) || { width: 0, widths: [] };
            if (width > maxWidth) {
                line.title = trancateText(line.title, maxWidth - 1, widths) + "…";
            }
        });
    }

    // Blank non-first lines of each consecutive same-commit block
    if (config.mergeCommitLines) {
        for (let i = 1; i < blames.length; i++) {
            if (blames[i].commited && blames[i].commit === blames[i - 1].commit) {
                blames[i].title = '';
            }
        }
    }

    return maxWidth;
}