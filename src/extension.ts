import path from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { Blame, Change, getBlames, getChanges, getEmptyTree, getFileStatus, getGitRepository, getParentCommitId } from './git';


// 全局状态
const fileBlameStates = new Map<string, boolean>();
const fileDecorations = new Map<string, {
    decorationTypes: vscode.TextEditorDecorationType[] | undefined,
    decorationOptions: vscode.DecorationOptions[][] | undefined,
    hoverProvider: vscode.Disposable | undefined,
    blames: Blame[] | undefined,
    lineBlames: Map<number, Blame> | undefined,
}>();
const MaxTitleWidth = 25;

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
}

/**
 * 卸载插件
 */
export function deactivate() {
    for (const [_, decorations] of fileDecorations) {
        decorations.decorationTypes?.forEach(type => type.dispose());
        decorations.hoverProvider?.dispose();
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

    // Visible Editor Change
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

    context.subscriptions.push(editorChangeSubscription, visibleEditorChangeSubscription, closeDocumentSubscription, saveDocumentSubscription, changeDocumentSubscription);
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
        };
    }
    fileDecorations.set(documentUri, decorations);

    try {
        // Blames
        const blames = await getBlames(path.dirname(document.fileName), document.fileName);
        for (let i = blames.length; i < document.lineCount; i++) {
            blames.push(buildUncommitBlame(i + 1));
        }

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
            { scheme: 'file', pattern: document.fileName },
            {
                provideHover(document: vscode.TextDocument, position: vscode.Position) {
                    if (position.character > 0) {
                        return undefined;
                    }
                    const blame = fileDecorations.get(documentUri)?.lineBlames?.get(position.line);
                    if (blame && blame.commited) {
                        const date = new Date(blame.timestamp * 1000);
                        const dateText = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

                        const content = new vscode.MarkdownString();
                        content.appendMarkdown(`commit: [${blame.commit}](command:git.blame.viewCommit?${encodeURIComponent(JSON.stringify([blame.commit, blame.summary, document.fileName]))})  \n`);
                        content.appendMarkdown(`Author: ${blame.author}  \n`);
                        content.appendMarkdown(`Date: ${dateText}  \n`);
                        if (blame.summary) {
                            content.appendMarkdown(`\n\n${blame.summary}`);
                        }
                        content.isTrusted = true;
                        return new vscode.Hover(content);
                    }
                }
            }
        );
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

function buildDecorationOptions(blames: Blame[]): vscode.DecorationOptions[][] {
    const maxWidth = fillTitles(blames);
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
        const option = {
            range,
            renderOptions: {
                before: {
                    contentText: `\u2007${blame.title}\u2007`,
                    color: '#666666',
                    width: `${maxWidth + 2}ch`,
                    fontWeight: 'normal',
                    fontStyle: 'normal',
                }
            }
        };
        decorationOptions.push(option);

        const optionHeatmap = {
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
            optionHeatmap.renderOptions.light.before.backgroundColor = 'transparent';
            optionHeatmap.renderOptions.dark.before.backgroundColor = 'transparent';
        }
        decorationOptionsHeatmap.push(optionHeatmap);
    });

    return [decorationOptions, decorationOptionsHeatmap];
}


function fillTitles(blames: Blame[]): number {
    let maxWidth = 0;

    // calculate date width
    const lineDates = new Map<number, string>();
    const maxDateWidth = blames.reduce((maxWidth, line) => {
        if (!line.commited) {
            return maxWidth;
        }
        const date = new Date(line.timestamp * 1000);
        const dateText = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
        lineDates.set(line.line, dateText);
        return Math.max(maxWidth, dateText.length);
    }, 8);

    const textWidths = new Map<string, { width: number, widths: number[] }>();
    blames.forEach(line => {
        if (line.commited) {
            const dateText = lineDates.get(line.line)?.padEnd(maxDateWidth, '\u2007');
            line.title = `${dateText} ${line.author}`;
        } else {
            line.title = '';
        }

        // calculate title width
        if (!textWidths.has(line.commit)) {
            const { width, widths } = getTextWidth(line.title);
            textWidths.set(line.commit, { width, widths });
            if (width > maxWidth) {
                maxWidth = width;
            }
        }
    });

    if (maxWidth > MaxTitleWidth) {
        maxWidth = MaxTitleWidth;
        // trancate title
        blames.forEach(line => {
            const { width, widths } = textWidths.get(line.commit) || { width: 0, widths: [] };
            if (width > maxWidth) {
                line.title = trancateText(line.title, maxWidth - 1, widths) + "…";
            }
        });
    }

    return maxWidth;
}

// ------------------------------------------------------------
// utils
// ------------------------------------------------------------

function toMultiFileDiffEditorUris(change: Change, originalRef: string, modifiedRef: string): { originalUri: Uri | undefined; modifiedUri: Uri | undefined } {
    switch (change.status) {
        case "index_added":
            return {
                originalUri: undefined,
                modifiedUri: toGitUri(change.uri, modifiedRef)
            };
        case "deleted":
            return {
                originalUri: toGitUri(change.uri, originalRef),
                modifiedUri: undefined
            };
        case "index_renamed":
            return {
                originalUri: toGitUri(change.originalUri, originalRef),
                modifiedUri: toGitUri(change.uri, modifiedRef)
            };
        default:
            return {
                originalUri: toGitUri(change.uri, originalRef),
                modifiedUri: toGitUri(change.uri, modifiedRef)
            };
    }
}

function toGitUri(uri: Uri, ref: string, options: { submoduleOf?: string, replaceFileExtension?: boolean, scheme?: string } = {}): Uri {
    const params = {
        path: uri.fsPath,
        submoduleOf: "",
        ref
    };

    if (options.submoduleOf) {
        params.submoduleOf = options.submoduleOf;
    }

    let path = uri.path;

    if (options.replaceFileExtension) {
        path = `${path}.git`;
    } else if (options.submoduleOf) {
        path = `${path}.diff`;
    }

    return uri.with({ scheme: options.scheme ?? 'git', path, query: JSON.stringify(params) });
}


function getTextWidth(text: string): { width: number, widths: number[] } {
    let width = 0;
    const widths = [];
    for (const char of text) {
        const w = getCharacterWidth(char);
        widths.push(w);
        width += w;
    }
    return { width, widths };
}


function getCharacterWidth(char: string): number {
    const code = char.charCodeAt(0);

    // 东亚文字 (中文、日文、韩文等)
    if ((code >= 0x3000 && code <= 0x9FFF) ||
        (code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0xF900 && code <= 0xFAFF) ||
        (code >= 0xFF00 && code <= 0xFFEF)) {
        return 2;
    }

    // 表情符号和特殊符号
    if (code >= 0x1F300 && code <= 0x1F9FF) {
        return 2;
    }

    // 组合字符标记
    if (code >= 0x0300 && code <= 0x036F) {
        return 0;
    }

    return 1;
}

function trancateText(text: string, maxWidth: number, widths: number[]): string {
    let truncatedText = '';
    let currentWidth = 0;

    for (let i = 0; i < widths.length; i++) {
        if (currentWidth + widths[i] <= maxWidth) {
            truncatedText += text[i];
            currentWidth += widths[i];
        } else {
            break;
        }
    }
    return truncatedText;
}

function getCommitColor(commit: string, timestamp: number): { lightColor: string, darkColor: string } {
    // hue
    let hash = 0;
    for (let i = 0; i < commit.length; i++) {
        hash = commit.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = (hash * 137.508) % 360;

    // saturation
    const minSaturation = 35, maxSaturation = 90, decayDays = 20;
    let daysAgo = Math.floor((Date.now() / 1000 - timestamp) / (24 * 60 * 60));
    daysAgo = Math.max(daysAgo, 0);
    const decay = Math.exp(-daysAgo / 20);
    const saturation = Math.round(minSaturation + (maxSaturation - minSaturation) * decay);

    const darkColor = `hsl(${h}, ${saturation}%, 50%)`;
    const lightColor = `hsl(${h}, ${saturation}%, 50%)`;
    return { lightColor, darkColor };
}

function buildUncommitBlame(line: number): Blame {
    return {
        line: line,
        commit: '0000000000000000000000000000000000000000',
        author: '',
        mail: '',
        timestamp: 0,
        summary: '',
        commited: false,
        title: '',
    };
}


function resolveChange(change: vscode.TextDocumentContentChangeEvent) {
    const addedLines = [];
    const deletedLines = [];
    const modifiedLines = [];
    const changeText = change.text;
    const startLine = change.range.start.line;
    const endLine = change.range.end.line;
    const startLineCharacter = change.range.start.character;

    if (changeText.length === 0) {
        // delete characters
        const diffLine = endLine - startLine;
        if (diffLine === 1) {
            deletedLines.push(startLine + 1);
        } else if (diffLine > 1) {
            const start = startLineCharacter > 0 ? startLine + 1 : startLine;
            const end = start + diffLine - 1;
            for (let i = start; i <= end; i++) {
                deletedLines.push(i);
            }
        } else if (diffLine === 0) {
            modifiedLines.push(startLine);
        }
    } else {
        const trimedChangeText = changeText.replace(/ +$/, '');
        if (trimedChangeText === '\n' || trimedChangeText === '\r\n') {
            // add a new line
            addedLines.push(startLineCharacter > 0 ? startLine + 1 : startLine);
        } else {
            // add or modify characters
            const crossLines = endLine - startLine + 1;
            const textLines = changeText.split(/\r?\n/).length;
            const diff = textLines - crossLines;
            if (diff > 0) {
                // modify lines
                for (let i = startLine; i <= endLine; i++) {
                    modifiedLines.push(i);
                }
                // add lines
                const start = endLine + 1;
                const end = endLine + diff;
                for (let i = start; i <= end; i++) {
                    addedLines.push(i);
                }
            } else if (diff < 0) {
                // modify lines
                for (let i = startLine; i <= endLine + diff; i++) {
                    modifiedLines.push(i);
                }
                // delete lines
                const start = endLine + diff + 1;
                const end = endLine;
                for (let i = start; i <= end; i++) {
                    deletedLines.push(i);
                }
            } else if (diff === 0) {
                // modify lines
                for (let i = startLine; i <= endLine; i++) {
                    modifiedLines.push(i);
                }
            }
        }
    }
    return { addedLines, deletedLines, modifiedLines };
}