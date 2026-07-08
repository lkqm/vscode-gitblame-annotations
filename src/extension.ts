import path from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { Blame, buildCommitUrl, getBlames, getChanges, getEmptyTree, getFileRevisionNumbers, getFileStatus, getGitRepository, getParentCommitId, getRepoWebBase } from './git';
import { registerLineHistoryProviders, showLineHistory } from './lineHistory';
import type { AuthorNameStyle, DateFormatStyle } from './utils';
import { VALID_AUTHORNAMESTYLES, VALID_DATEFORMATSTYLES, buildUncommitBlame, defaultAuthorNameStyle, defaultDateFormatStyle, formatAuthor, formatDate, getCommitColor, getTextWidth, resolveChange, toGitUri, toMultiFileDiffEditorUris, trancateText, validateConfigEnum } from './utils';

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
const gitDocumentRepositories = new Map<string, string>();


interface BlameDisplayConfig {
    mergeCommitLines: boolean,
    highlightChangedLines: boolean,
    showCommitNumber: boolean,
    dateFormatStyle: DateFormatStyle,
    authorNameStyle: AuthorNameStyle
}

interface BlameDocumentContext {
    fileName: string,
    ref?: string,
    repositoryRoot: string,
}

interface GitDocumentParams {
    path?: string,
    ref?: string,
    submoduleOf?: string,
    repositoryRoot?: string,
}

interface AuthorDisplay {
    text: string,
    width: number,
    widths: number[],
}

const MaxAuthorWidth = 14;

/**
* 激活插件
*/
export function activate(context: vscode.ExtensionContext) {
    registerLineHistoryProviders(context);
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
    const viewCommitCommand = vscode.commands.registerCommand('git.blame.viewCommit', async (commitId: string, summary: string = "", fileName: string = "", repositoryRoot: string = "") => {
        if (fileName) {
            repositoryRoot = repositoryRoot || await getGitRepository(fileName);
            if (!repositoryRoot) {
                return;
            }
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

    // Copy commit hash
    const copyHashCommand = vscode.commands.registerCommand('git.blame.copyHash', async (hash: string) => {
        if (!hash) return;
        vscode.env.clipboard.writeText(hash);
    });

    // Annotate previous revision
    const annotatePreviousRevisionCommand = vscode.commands.registerCommand('git.blame.annotatePreviousRevision', async (previousCommit: string, previousFile: string = "", fileName: string = "", repositoryRoot: string = "", languageId: string = "") => {
        if (!previousCommit || !fileName) {
            return;
        }

        try {
            const repoRoot = repositoryRoot || await getGitRepository(fileName);
            if (!repoRoot) {
                return;
            }

            const previousFileName = previousFile
                ? (path.isAbsolute(previousFile) ? previousFile : path.join(repoRoot, previousFile))
                : fileName;
            const uri = toNamedGitUri(previousFileName, previousCommit, repoRoot);
            gitDocumentRepositories.set(uri.toString(), repoRoot);
            let editor = await vscode.window.showTextDocument(uri, { preview: false });
            if (languageId && editor.document.languageId !== languageId) {
                const document = await vscode.languages.setTextDocumentLanguage(editor.document, languageId);
                editor = await vscode.window.showTextDocument(document, { preview: false });
                gitDocumentRepositories.set(editor.document.uri.toString(), repoRoot);
            }
            const successed = await showDecorations([editor], true);
            if (successed) {
                updateMenuContext(editor.document, true);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`${error.message}`);
        }
    });

    // View line history
    const viewLineHistoryCommand = vscode.commands.registerCommand('git.blame.viewLineHistory', async (fileName: string = "", lineNumber?: number, ref?: string, repositoryRoot: string = "") => {
        const activeEditor = vscode.window.activeTextEditor;
        let targetLine = lineNumber;
        let activeDocument: vscode.TextDocument | undefined;

        if (!fileName && activeEditor) {
            const blameContext = await getBlameDocumentContext(activeEditor.document);
            fileName = blameContext?.fileName ?? "";
            ref = blameContext?.ref;
            repositoryRoot = blameContext?.repositoryRoot ?? "";
            targetLine = activeEditor.selection.active.line + 1;
            activeDocument = activeEditor.document;
        } else if (activeEditor?.document.fileName === fileName) {
            activeDocument = activeEditor.document;
        }

        await showLineHistory({
            fileName,
            lineNumber: targetLine,
            ref,
            repositoryRoot,
            activeDocument,
        });
    });

    context.subscriptions.push(toggleCommand, showCommand, hideCommand, viewCommitCommand, copyHashCommand, annotatePreviousRevisionCommand, viewLineHistoryCommand);
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
        gitDocumentRepositories.delete(documentUri);
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
        const enabled = vscode.workspace.getConfiguration('gitblame').get("highlightChangedLines", false) as boolean;
        if (!enabled) return;

        const editor = event.textEditor;
        const uri = editor.document.uri.toString();
        if (!fileBlameStates.get(uri)) return;
        const state = fileDecorations.get(uri);
        if (!state) return;

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
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'git') {
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
        const blameContext = await getBlameDocumentContext(document);
        if (!blameContext) {
            return false;
        }

        // Blames
        const blameFile = getRepositoryRelativePath(blameContext.repositoryRoot, blameContext.fileName);
        const blames = await getBlames(blameContext.repositoryRoot, blameFile, blameContext.ref);
        const showCommitNumber = vscode.workspace.getConfiguration('gitblame').get('showCommitNumber', false);
        if (showCommitNumber) {
            const commitNumbers = await getFileRevisionNumbers(blameContext.repositoryRoot, blameFile, blameContext.ref);
            applyCommitNumbers(blames, commitNumbers);
        }
        for (let i = blames.length; i < document.lineCount; i++) {
            blames.push(buildUncommitBlame(i + 1));
        }

        // Repo web base for commit links
        const repoWebBase = blameContext.repositoryRoot ? await getRepoWebBase(blameContext.repositoryRoot) : "";

        // Decorations
        if (!decorations.decorationTypes) {
            decorations.decorationTypes = [];
        }

        decorations.decorationOptions = buildDecorationOptions(blames);
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
        decorations.hoverProvider = vscode.languages.registerHoverProvider(
            {
                scheme: document.uri.scheme,
                pattern: document.uri.fsPath,
            },
            {
                async provideHover(document: vscode.TextDocument, position: vscode.Position) {
                    if (document.uri.toString() !== documentUri) {
                        return undefined;
                    }
                    if (position.character > 0) {
                        return undefined;
                    }
                    const blame = fileDecorations.get(documentUri)?.lineBlames?.get(position.line);
                    if (!blame) {
                        return undefined;
                    }

                    const content = buildHoverMessage(blame, blameContext.fileName, repoWebBase, blameContext.repositoryRoot, document.languageId, blameContext.ref);
                    if (!content) {
                        return undefined;
                    }
                    return new vscode.Hover(content, new vscode.Range(position.line, 0, position.line, 0));
                }
            }
        );
        fileBlameStates.set(documentUri, true);
        return true;
    } catch (error: any) {
        if (document.uri.scheme === 'git' || !error.message.includes("code 128")) {
            vscode.window.showErrorMessage(`${error.message}`);
        }
        return false;
    }
}

async function getBlameDocumentContext(document: vscode.TextDocument): Promise<BlameDocumentContext | undefined> {
    if (document.uri.scheme === 'file') {
        const repositoryRoot = await getGitRepository(document.fileName);
        if (!repositoryRoot) {
            return undefined;
        }

        return {
            fileName: document.fileName,
            repositoryRoot,
        };
    }

    if (document.uri.scheme === 'git') {
        try {
            const params = JSON.parse(document.uri.query) as GitDocumentParams;
            if (!params.path || !params.ref) {
                return undefined;
            }

            const repositoryRoot = params.repositoryRoot
                || gitDocumentRepositories.get(document.uri.toString())
                || findWorkspaceRootForPath(params.path)
                || await getGitRepository(params.path);
            if (!repositoryRoot) {
                return undefined;
            }

            return {
                fileName: params.path,
                ref: params.ref,
                repositoryRoot,
            };
        } catch (_) {
            return undefined;
        }
    }

    return undefined;
}

function getRepositoryRelativePath(repositoryRoot: string, fileName: string): string {
    const relativePath = path.relative(repositoryRoot, fileName);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return fileName;
    }

    return relativePath;
}

function toNamedGitUri(fileName: string, ref: string, repositoryRoot: string): Uri {
    const uri = toGitUri(Uri.file(fileName), ref);
    const parsedPath = path.posix.parse(uri.path);
    const displayPath = path.posix.join(parsedPath.dir, `${parsedPath.base} (${ref.substring(0, 8)})`);
    const params = JSON.parse(uri.query) as GitDocumentParams;
    return uri.with({
        path: displayPath,
        query: JSON.stringify({ ...params, repositoryRoot }),
    });
}

function applyCommitNumbers(blames: Blame[], commitNumbers: Map<string, number>) {
    blames.forEach(blame => {
        blame.commitNumber = commitNumbers.get(blame.commit);
    });
}

function findWorkspaceRootForPath(fileName: string): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    return workspaceFolders
        .map(folder => folder.uri.fsPath)
        .filter(root => isPathInside(root, fileName))
        .sort((a, b) => b.length - a.length)[0];
}

function isPathInside(root: string, fileName: string): boolean {
    const relativePath = path.relative(root, fileName);
    return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
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

    // update decorations
    decorations.decorationOptions = buildDecorationOptions(blames);
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
    if (currentState !== undefined) {
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', !currentState);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', currentState);
        return;
    }

    let supportsBlameMenu = false;
    if (document.uri.scheme === 'git') {
        try {
            const params = JSON.parse(document.uri.query) as GitDocumentParams;
            supportsBlameMenu = !!params.path && !!params.ref;
        } catch (_) {
            supportsBlameMenu = false;
        }
    } else if (document.uri.scheme === 'file') {
        try {
            const fileStatus = await getFileStatus(path.dirname(document.fileName), document.fileName);
            supportsBlameMenu = fileStatus !== "untracked" && fileStatus !== "index_add";
        } catch (_) {
            supportsBlameMenu = false;
        }
    }

    const fileBlameState = fileBlameStates.get(document.uri.toString()) || false;
    vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', supportsBlameMenu && !fileBlameState);
    vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', supportsBlameMenu && fileBlameState);
}

function buildDecorationOptions(blames: Blame[]): vscode.DecorationOptions[][] {
    const cfg = vscode.workspace.getConfiguration('gitblame');

    const config: BlameDisplayConfig = {
        mergeCommitLines: cfg.get('mergeCommitLines', false),
        highlightChangedLines: cfg.get('highlightChangedLines', false),
        showCommitNumber: cfg.get('showCommitNumber', false),
        dateFormatStyle: validateConfigEnum(cfg, VALID_DATEFORMATSTYLES, 'dateFormatStyle', defaultDateFormatStyle),
        authorNameStyle: validateConfigEnum(cfg, VALID_AUTHORNAMESTYLES, 'authorNameStyle', defaultAuthorNameStyle),
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
        const option: vscode.DecorationOptions = {
            range,
            renderOptions: {
                before: {
                    contentText: `\u2007${blame.title}\u2007`,
                    color: new vscode.ThemeColor('list.deemphasizedForeground'),
                    width: `${maxWidth + 2}ch`,
                    fontWeight: 'normal',
                    fontStyle: 'normal'
                }
            }
        };
        decorationOptions.push(option);

        const optionHeatmap: vscode.DecorationOptions = {
            range,
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

function buildHoverMessage(blame: Blame, fileName: string, repoWebBase: string, repositoryRoot: string, languageId: string, ref?: string): vscode.MarkdownString | undefined {
    if (!blame.commited) {
        return undefined;
    }

    const rawStyle = vscode.workspace.getConfiguration('gitblame').get('dateFormatStyle', defaultDateFormatStyle);
    const activeStyle: DateFormatStyle = VALID_DATEFORMATSTYLES.includes(rawStyle as DateFormatStyle)
        ? (rawStyle as DateFormatStyle)
        : defaultDateFormatStyle;

    const relativeDate = formatDate(blame.timestamp, 'relative')
    const hoverStyle: DateFormatStyle = activeStyle === 'relative' ? 'YYYY-MM-DD' : activeStyle;
    const dateText = formatDate(blame.timestamp, hoverStyle);

    const content = new vscode.MarkdownString();
    const [commitUrl, gitPlatform] = buildCommitUrl(repoWebBase, blame.commit);
    let viewExternal = '';
    content.appendMarkdown(`**[${blame.author}](mailto:${blame.mail})**  \n`);
    content.appendMarkdown(`_${relativeDate}_ (${dateText})  \n`)

    if (blame.summary) {
        content.appendMarkdown(`\n\n${blame.summary}`);
    }

    if (commitUrl) {
        const viewText = gitPlatform ? `Open on ${gitPlatform}` : 'Open in Browser';
        viewExternal = ` | [${viewText}](${commitUrl})`
    }

    const openCommitUri = encodeURIComponent(JSON.stringify([blame.commit, blame.summary, fileName, repositoryRoot]))
    const commit7 = `[${blame.commit.slice(0, 8)}](command:git.blame.viewCommit?${openCommitUri})`

    const copyIcon = `[$(copy)](command:git.blame.copyHash?${encodeURIComponent(JSON.stringify([blame.commit]))})`
    let annotatePreviousRevision = '';
    if (blame.previousCommit) {
        const annotatePreviousRevisionUri = encodeURIComponent(JSON.stringify([blame.previousCommit, blame.previousFile ?? "", fileName, repositoryRoot, languageId]));
        annotatePreviousRevision = ` | [Previous Revision](command:git.blame.annotatePreviousRevision?${annotatePreviousRevisionUri})`;
    }
    const viewLineHistoryUri = encodeURIComponent(JSON.stringify([fileName, blame.line, ref, repositoryRoot, languageId]));

    content.appendMarkdown("\n\n---\n\n")
    content.appendMarkdown(`$(git-commit) ${commit7} ${copyIcon}${viewExternal}${annotatePreviousRevision} | [Line History](command:git.blame.viewLineHistory?${viewLineHistoryUri})  \n`);

    content.isTrusted = true;
    content.supportThemeIcons = true;
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
    const maxCommitNumberWidth = config.showCommitNumber
        ? blames.reduce((maxW, line) => {
            if (!line.commited || !line.commitNumber) { return maxW; }
            return Math.max(maxW, `${line.commitNumber}`.length);
        }, 0)
        : 0;
    const lineAuthorDisplay = new Map<number, AuthorDisplay>();
    const maxAuthorWidth = getMaxAuthorWidth(blames, config.authorNameStyle, lineAuthorDisplay);
    blames.forEach(line => {
        if (line.commited) {
            const tsText = (lineTimestampText.get(line.line) ?? '').padEnd(maxTimestampWidth, '\u2007');
            const authorText = buildAuthorBlock(lineAuthorDisplay.get(line.line)!, maxAuthorWidth);
            const commitNumberText = config.showCommitNumber && line.commitNumber
                ? ` ${`${line.commitNumber}`.padStart(maxCommitNumberWidth, '\u2007')}`
                : '';
            line.title = `${tsText} ${authorText}${commitNumberText}`;
        } else {
            line.title = '';
        }

        const { width } = getTextWidth(line.title);
        if (width > maxWidth) { maxWidth = width; }
    });

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

function getMaxAuthorWidth(blames: Blame[], authorNameStyle: AuthorNameStyle, lineAuthorDisplay: Map<number, AuthorDisplay>): number {
    const maxWidth = blames.reduce((maxW, line) => {
        if (!line.commited) { return maxW; }
        const text = formatAuthor(line.author, authorNameStyle);
        const { width, widths } = getTextWidth(text);
        lineAuthorDisplay.set(line.line, { text, width, widths });
        return Math.max(maxW, width);
    }, 0);

    return Math.min(maxWidth, MaxAuthorWidth);
}

function buildAuthorBlock(author: AuthorDisplay, maxAuthorWidth: number): string {
    if (author.width <= maxAuthorWidth) {
        return author.text.padEnd(author.text.length + maxAuthorWidth - author.width, '\u2007');
    }

    return trancateText(author.text, maxAuthorWidth - 1, author.widths) + "…";
}
