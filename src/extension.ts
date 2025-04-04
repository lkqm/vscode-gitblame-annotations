import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { Blame, Change, getBlames, getChanges, getEmptyTree, getFileStatus, getGitRepository, getParentCommitId } from './git';


// 全局状态
const fileBlameStates = new Map<string, boolean>();
const fileDecorations = new Map<string, {
    decorationType: vscode.TextEditorDecorationType | undefined,
    decorationOptions: vscode.DecorationOptions[] | undefined,
    hoverProvider: vscode.Disposable | undefined,
}>();
const MaxTitleWidth = 25;
let previousThemeKind = vscode.window.activeColorTheme.kind;

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
        if (decorations.decorationType) {
            decorations.decorationType.dispose();
        }
        if (decorations.hoverProvider) {
            decorations.hoverProvider.dispose();
        }
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
            const fileBlameState = fileBlameStates.get(editor.document.uri.toString()) || false;
            if (!fileBlameState) {
                const successed = await showDecorations(editor);
                if (successed) {
                    updateMenuContext(editor.document, true);
                }
            } else {
                const successed = await hideDecorations(editor);
                if (successed) {
                    updateMenuContext(editor.document, false);
                }
            }
        }
    });

    // Show blame annotations
    const showCommand = vscode.commands.registerCommand('git.blame.show', async (event?: any) => {
        const editors = event && event.uri ? vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === event.uri.toString()) : [vscode.window.activeTextEditor];
        for (const editor of editors) {
            if (editor) {
                const successed = await showDecorations(editor);
                if (successed) {
                    updateMenuContext(editor.document, true);
                }
            }
        }
    });

    // Hide blame annotations
    const hideCommand = vscode.commands.registerCommand('git.blame.hide', async (event?: any) => {
        const editors = event && event.uri ? vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === event.uri.toString()) : [vscode.window.activeTextEditor];
        for (const editor of editors) {
            if (editor) {
                const successed = await hideDecorations(editor);
                if (successed) {
                    updateMenuContext(editor.document, false);
                }
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
                showDecorations(editor);
            }
        }
    });

    // Document Close
    const closeDocumentSubscription = vscode.workspace.onDidCloseTextDocument(document => {
        const documentUri = document.uri.toString();
        fileBlameStates.delete(documentUri);
        const decorations = fileDecorations.get(documentUri);
        if (decorations) {
            if (decorations.decorationType) {
                decorations.decorationType.dispose();
            }
            if (decorations.hoverProvider) {
                decorations.hoverProvider.dispose();
            }
            fileDecorations.delete(documentUri);
        }
    });

    // Document Save
    const saveDocumentSubscription = vscode.workspace.onDidSaveTextDocument(document => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document) {
            const fileBlameState = fileBlameStates.get(editor.document.uri.toString());
            if (fileBlameState) {
                showDecorations(editor, true);
            }
        }
    });

    // Theme Change
    const themeChangeSubscription = vscode.window.onDidChangeActiveColorTheme((e) => {
        if (previousThemeKind !== e.kind) {
            const currentIsDarkTheme = (e.kind === vscode.ColorThemeKind.Dark || e.kind === vscode.ColorThemeKind.HighContrast);
            const previousIsDarkTheme = (previousThemeKind === vscode.ColorThemeKind.Dark || previousThemeKind === vscode.ColorThemeKind.HighContrast);
            previousThemeKind = e.kind;
            if (currentIsDarkTheme !== previousIsDarkTheme) {
                for (const editor of vscode.window.visibleTextEditors) {
                    const fileBlameState = fileBlameStates.get(editor.document.uri.toString());
                    if (fileBlameState) {
                        showDecorations(editor, true);
                    }
                }
            }
        }
    });

    context.subscriptions.push(editorChangeSubscription, visibleEditorChangeSubscription, themeChangeSubscription, closeDocumentSubscription, saveDocumentSubscription);
}

/**
 * 显示装饰器
 */
async function showDecorations(editor: vscode.TextEditor, reload: boolean = false): Promise<boolean> {
    const document = editor.document;
    const documentUri = document.uri.toString();
    let decorations = fileDecorations.get(documentUri);

    // Skip diff editor
    if (document.uri.scheme !== 'file') {
        return false;
    }

    // Use cache
    if (!reload && decorations && decorations.decorationType && decorations.decorationOptions) {
        editor.setDecorations(decorations.decorationType, decorations.decorationOptions);
        fileBlameStates.set(documentUri, true);
        return true;
    }

    // Check file
    const repositoryRoot = await getGitRepository(document.fileName);
    if (!repositoryRoot) {
        return false;
    }
    const tracked = await isFileTracked(repositoryRoot, document.fileName);
    if (!tracked) {
        return false;
    }
    if (decorations) {
        decorations.decorationType?.dispose();
        decorations.hoverProvider?.dispose();
        decorations.decorationType = undefined;
        decorations.decorationOptions = undefined;
        decorations.hoverProvider = undefined;
    } else {
        decorations = {
            decorationType: undefined,
            decorationOptions: undefined,
            hoverProvider: undefined,
        }
    }
    fileDecorations.set(documentUri, decorations);


    try {
        const blames = await getBlames(repositoryRoot, document.fileName);
        while (blames.length < document.lineCount) {
            blames.push({
                commit: '',
                author: '',
                timestamp: 0,
                summary: '',
                commited: false,
                title: '',
                line: blames.length + 1
            });
        }
        const maxWidth = fillTitles(blames);
        if (maxWidth <= 0) {
            return false;
        }

        const decorationOptions: vscode.DecorationOptions[] = [];
        const blamesMap = new Map<number, Blame>();
        const commitColors = new Map<string, string>();
        blames.forEach((line, index) => {
            blamesMap.set(index, line);
            const range = new vscode.Range(
                new vscode.Position(index, 0),
                new vscode.Position(index, 0)
            );
            let color = commitColors.get(line.commit);
            if (!color) {
                color = getCommitColor(line.commit);
                commitColors.set(line.commit, color);
            }

            decorationOptions.push({
                range,
                renderOptions: {
                    before: {
                        contentText: `\u2007${line.title}\u2007`,
                        color: '#666666',
                        margin: '0 1ch 0 0',
                        width: `${maxWidth + 2}ch`,
                        fontWeight: 'normal',
                        fontStyle: 'normal',
                        backgroundColor: color
                    }
                }
            });
        });

        // Decorations
        if (decorations.decorationType) {
            decorations.decorationType.dispose();
        }
        decorations.decorationOptions = decorationOptions;
        decorations.decorationType = vscode.window.createTextEditorDecorationType({});
        editor.setDecorations(decorations.decorationType, decorationOptions);

        // Hover provider
        if (decorations.hoverProvider) {
            decorations.hoverProvider.dispose();
        }
        decorations.hoverProvider = vscode.languages.registerHoverProvider(
            { scheme: 'file', pattern: document.fileName },
            {
                provideHover(document: vscode.TextDocument, position: vscode.Position) {
                    if (position.character > 0) {
                        return undefined;
                    }

                    const blame = blamesMap.get(position.line);
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
        vscode.window.showErrorMessage(`Git Blame error: ${error.message || 'Unknown error'}`);
        return false;
    }
}

/**
 * 隐藏装饰器
 */
async function hideDecorations(editor: vscode.TextEditor): Promise<boolean> {
    const documentUri = editor.document.uri.toString();
    fileBlameStates.set(documentUri, false);
    let decorations = fileDecorations.get(documentUri);
    if (decorations) {
        if (decorations.decorationType) {
            decorations.decorationType.dispose();
            decorations.decorationType = undefined;
            decorations.decorationOptions = undefined;
        }
        if (decorations.hoverProvider) {
            decorations.hoverProvider.dispose();
            decorations.hoverProvider = undefined;
        }
        return true;
    }
    return false;
}


async function updateMenuContext(document: vscode.TextDocument, currentState: boolean | undefined = undefined) {
    if (currentState !== undefined) {
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', !currentState);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', currentState);
        return;
    }

    // Skip diff editor
    if (document.uri.scheme !== 'file') {
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', false);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', false);
        return;
    }

    // check repository root
    const repositoryRoot = await getGitRepository(document.fileName);
    if (!repositoryRoot) {
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', false);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', false);
        return;
    }

    // check file tracked
    const fileTracked = await isFileTracked(repositoryRoot, document.fileName);
    if (!fileTracked) {
        vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', false);
        vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', false);
        return;
    }

    // check file blame state
    const fileBlameState = fileBlameStates.get(document.uri.toString());
    vscode.commands.executeCommand('setContext', 'gitblame.showMenuState', !fileBlameState);
    vscode.commands.executeCommand('setContext', 'gitblame.hideMenuState', fileBlameState);
}


function fillTitles(blames: Blame[]): number {
    let maxWidth = 0;
    const textWidths = new Map<string, { width: number, widths: number[] }>();
    blames.forEach(line => {
        if (line.commited) {
            const date = new Date(line.timestamp * 1000);
            const dateText = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
            line.title = `${dateText} ${line.author}`;
        } else {
            line.title = '';
        }

        // calculate title width
        if (!textWidths.has(line.commit)) {
            const { width, widths } = calculateTextWidth(line.title);
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

async function isFileTracked(repositoryRoot: string, file: string): Promise<boolean> {
    const fileStatus = await getFileStatus(repositoryRoot, file);
    return fileStatus !== "untracked" && fileStatus !== "index_add";
}

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


function calculateTextWidth(text: string): { width: number, widths: number[] } {
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

function getCommitColor(commit: string): string {
    let hash = 0;
    for (let i = 0; i < commit.length; i++) {
        hash = commit.charCodeAt(i) + ((hash << 5) - hash);
    }
    const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
    const h = hash % 360;
    if (isDarkTheme) {
        return `hsl(${h}, 15%, 15%)`;
    } else {
        return `hsl(${h}, 20%, 95%)`;
    }
}