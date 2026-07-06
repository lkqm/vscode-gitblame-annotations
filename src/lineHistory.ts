import path from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { Blame, Change, LineParentMapping as GitLineParentMapping, getBlameLine, getChanges, getEmptyTree, getGitRepository, getLineParentMapping, getParentCommitIds } from './git';
import type { DateFormatStyle } from './utils';
import { VALID_DATEFORMATSTYLES, defaultDateFormatStyle, formatDate, toGitUri, toMultiFileDiffEditorUris } from './utils';

interface LineHistoryEntry {
    blame: Blame,
    fileName: string,
    lineNumber: number,
    lineText: string,
    changeKind: LineHistoryChangeKind,
}

type LineHistoryChangeKind = 'A' | 'M' | 'R' | 'D';

interface LineHistoryQuickPickItem extends vscode.QuickPickItem {
    entry?: LineHistoryEntry,
    command?: 'loadMore',
}

interface LineHistoryDiffTarget {
    parentCommitId: string,
    resource: { originalUri: Uri | undefined; modifiedUri: Uri | undefined },
}

interface LineHistoryCursor {
    currentFileName: string,
    currentLineNumber: number,
    currentRef?: string,
    visited: Set<string>,
    loaded: number,
    done: boolean,
}

type LineHistoryParentMapping =
    | {
        kind: 'M' | 'R',
        parentCommit: string,
        previousFile: string,
        previousLine: number,
    }
    | {
        kind: 'A',
    };

export interface ShowLineHistoryOptions {
    fileName: string,
    lineNumber?: number,
    ref?: string,
    repositoryRoot?: string,
    activeDocument?: vscode.TextDocument,
}

const LineHistoryPageSize = 2;
const LineHistoryAutoLoadLimit = 200;
const LineHistoryLoadMoreSize = 100;
const EmptyDiffDocumentScheme = 'gitblame-empty-diff';

export function registerLineHistoryProviders(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(EmptyDiffDocumentScheme, {
        provideTextDocumentContent: () => '',
    }));
}

export async function showLineHistory(options: ShowLineHistoryOptions) {
    let { fileName, lineNumber, ref, repositoryRoot, activeDocument } = options;

    if (!fileName || !lineNumber) {
        vscode.window.showInformationMessage('Open a tracked file and place the cursor on a line to view line history.');
        return;
    }

    if (!repositoryRoot) {
        repositoryRoot = await getGitRepository(fileName);
    }

    if (!repositoryRoot) {
        vscode.window.showInformationMessage('No Git repository found for this file.');
        return;
    }

    try {
        const cursor = createLineHistoryCursor(fileName, lineNumber, ref);
        const entries = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: 'Loading line history...',
            },
            () => loadLineHistoryBatch(repositoryRoot!, cursor, activeDocument)
        );

        if (entries.length === 0) {
            return;
        }

        const quickPick = vscode.window.createQuickPick<LineHistoryQuickPickItem>();
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.items = toLineHistoryQuickPickItems(entries, cursor, LineHistoryAutoLoadLimit);
        quickPick.buttons = [];
        quickPick.busy = !cursor.done;
        let disposed = false;
        let loadLimit = LineHistoryAutoLoadLimit;
        let loadingMore = false;

        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0];
            if (selected?.command === 'loadMore') {
                if (loadingMore) {
                    return;
                }

                loadingMore = true;
                const previousEntryCount = entries.length;
                loadLimit += LineHistoryLoadMoreSize;
                try {
                    await loadLineHistoryUntilLimit(repositoryRoot!, cursor, entries, quickPick, activeDocument, () => disposed, loadLimit);
                    focusLineHistoryEntry(quickPick, entries[previousEntryCount]);
                } finally {
                    loadingMore = false;
                }
                return;
            }

            quickPick.hide();
            if (selected?.entry) {
                await openLineHistoryFileDiff(selected.entry, repositoryRoot!);
            }
        });

        quickPick.onDidHide(() => {
            disposed = true;
            quickPick.dispose();
        });
        quickPick.show();

        void loadLineHistoryUntilLimit(repositoryRoot, cursor, entries, quickPick, activeDocument, () => disposed, loadLimit);
    } catch (error: any) {
        vscode.window.showErrorMessage(`${error.message}`);
    }
}

async function loadLineHistoryUntilLimit(
    repositoryRoot: string,
    cursor: LineHistoryCursor,
    entries: LineHistoryEntry[],
    quickPick: vscode.QuickPick<LineHistoryQuickPickItem>,
    activeDocument: vscode.TextDocument | undefined,
    isDisposed: () => boolean,
    loadLimit: number
) {
    try {
        while (!isDisposed() && !cursor.done && cursor.loaded < loadLimit) {
            quickPick.busy = true;
            const nextEntries = await loadLineHistoryBatch(repositoryRoot, cursor, activeDocument);
            if (nextEntries.length === 0) {
                break;
            }

            entries.push(...nextEntries);
            if (!isDisposed()) {
                quickPick.items = toLineHistoryQuickPickItems(entries, cursor, loadLimit);
            }
        }
    } catch (error: any) {
        if (!isDisposed()) {
            vscode.window.showErrorMessage(`${error.message}`);
        }
    } finally {
        if (!isDisposed()) {
            quickPick.busy = false;
            quickPick.items = toLineHistoryQuickPickItems(entries, cursor, loadLimit);
        }
    }
}

async function openLineHistoryFileDiff(entry: LineHistoryEntry, repositoryRoot: string) {
    const commitId = entry.blame.commit;
    const diffTarget = await resolveLineHistoryDiffTarget(repositoryRoot, entry);

    const title = `${commitId.substring(0, 7)} - ${path.basename(entry.fileName)}`;
    const originalUri = diffTarget.resource.originalUri ?? toEmptyDiffUri(entry.fileName, diffTarget.parentCommitId);
    const modifiedUri = diffTarget.resource.modifiedUri ?? toEmptyDiffUri(entry.fileName, commitId);
    await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title, { preview: false });
}

function toEmptyDiffUri(fileName: string, ref: string): Uri {
    return Uri.from({
        scheme: EmptyDiffDocumentScheme,
        path: `/${path.basename(fileName) || 'empty'}`,
        query: JSON.stringify({ ref, fileName }),
    });
}

async function resolveLineHistoryDiffTarget(repositoryRoot: string, entry: LineHistoryEntry): Promise<LineHistoryDiffTarget> {
    const commitId = entry.blame.commit;
    let parentCommitIds = await getParentCommitIds(repositoryRoot, commitId);
    if (parentCommitIds.length === 0) {
        parentCommitIds = [await getEmptyTree(repositoryRoot)];
    }

    for (const parentCommitId of parentCommitIds) {
        const changes = await getChanges(repositoryRoot, parentCommitId, commitId);
        const change = findChangeForFile(changes, entry.fileName);
        if (change) {
            return {
                parentCommitId,
                resource: toMultiFileDiffEditorUris(change, parentCommitId, commitId),
            };
        }
    }

    const parentCommitId = parentCommitIds[0];
    return {
        parentCommitId,
        resource: {
            originalUri: toGitUri(Uri.file(entry.fileName), parentCommitId),
            modifiedUri: toGitUri(Uri.file(entry.fileName), commitId),
        },
    };
}

function findChangeForFile(changes: Change[], fileName: string): Change | undefined {
    return changes.find(c => isSamePath(c.uri.fsPath, fileName) || isSamePath(c.originalUri.fsPath, fileName));
}

function isSamePath(pathA: string, pathB: string): boolean {
    return path.normalize(pathA) === path.normalize(pathB);
}

function createLineHistoryCursor(fileName: string, lineNumber: number, ref?: string): LineHistoryCursor {
    return {
        currentFileName: fileName,
        currentLineNumber: lineNumber,
        currentRef: ref,
        visited: new Set<string>(),
        loaded: 0,
        done: false,
    };
}

async function loadLineHistoryBatch(repositoryRoot: string, cursor: LineHistoryCursor, activeDocument?: vscode.TextDocument): Promise<LineHistoryEntry[]> {
    const entries: LineHistoryEntry[] = [];

    while (!cursor.done && entries.length < LineHistoryPageSize) {
        const key = `${cursor.currentRef ?? 'WORKTREE'}:${cursor.currentFileName}:${cursor.currentLineNumber}`;
        if (cursor.visited.has(key)) {
            cursor.done = true;
            break;
        }
        cursor.visited.add(key);

        const blameLine = await getBlameLineAtLine(repositoryRoot, cursor.currentFileName, cursor.currentLineNumber, cursor.currentRef);
        if (!blameLine?.blame.commited) {
            cursor.done = true;
            break;
        }

        const blame = blameLine.blame;
        const entryFileName = resolveHistoricalFileName(repositoryRoot, cursor.currentFileName, blame.filename);
        const lineText = getActiveDocumentLineText(cursor.currentFileName, cursor.currentLineNumber, cursor.currentRef, activeDocument) ?? blameLine.lineText.trim();
        const parentMapping = await resolveLineHistoryParentMapping(repositoryRoot, cursor.currentFileName, blame);
        entries.push({
            blame,
            fileName: entryFileName,
            lineNumber: cursor.currentLineNumber,
            lineText,
            changeKind: parentMapping.kind,
        });
        cursor.loaded++;

        if (parentMapping.kind === 'A') {
            cursor.done = true;
            break;
        }

        cursor.currentRef = parentMapping.parentCommit;
        cursor.currentFileName = parentMapping.previousFile;
        cursor.currentLineNumber = parentMapping.previousLine;
    }

    return entries;
}

async function getBlameLineAtLine(repositoryRoot: string, fileName: string, lineNumber: number, ref?: string) {
    const blameFile = getRepositoryRelativePath(repositoryRoot, fileName);
    try {
        return await getBlameLine(repositoryRoot, blameFile, lineNumber, ref);
    } catch (_) {
        return undefined;
    }
}

function getActiveDocumentLineText(fileName: string, lineNumber: number, ref?: string, activeDocument?: vscode.TextDocument): string | undefined {
    if (!ref && activeDocument?.fileName === fileName && lineNumber <= activeDocument.lineCount) {
        return activeDocument.lineAt(lineNumber - 1).text.trim();
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

function resolveHistoricalFileName(repositoryRoot: string, currentFileName: string, previousFile?: string): string {
    if (!previousFile) {
        return currentFileName;
    }

    return path.isAbsolute(previousFile) ? previousFile : path.join(repositoryRoot, previousFile);
}

async function resolveLineHistoryParentMapping(repositoryRoot: string, currentFileName: string, blame: Blame): Promise<LineHistoryParentMapping> {
    if (!blame.previousCommit) {
        return { kind: 'A' };
    }

    const blameFileName = resolveHistoricalFileName(repositoryRoot, currentFileName, blame.filename);
    const blameFile = getRepositoryRelativePath(repositoryRoot, blameFileName);
    const previousFileName = resolveHistoricalFileName(repositoryRoot, currentFileName, blame.previousFile);
    const previousFile = getRepositoryRelativePath(repositoryRoot, previousFileName);
    const lineInBlamedCommit = blame.sourceLine || blame.line;

    let mapping: GitLineParentMapping | undefined;
    try {
        mapping = await getLineParentMapping(repositoryRoot, blame.previousCommit, blame.commit, uniqueFiles([blameFile, previousFile]), lineInBlamedCommit);
    } catch (_) {
        return { kind: 'A' };
    }

    if (!mapping?.previousLine) {
        return { kind: 'A' };
    }

    const mappedPreviousFileName = resolveHistoricalFileName(
        repositoryRoot,
        currentFileName,
        mapping.previousFile || blame.previousFile
    );
    const kind = mapping.kind === 'R' || !isSamePath(mappedPreviousFileName, currentFileName) ? 'R' : 'M';
    return {
        kind,
        parentCommit: blame.previousCommit,
        previousFile: mappedPreviousFileName,
        previousLine: mapping.previousLine,
    };
}

function uniqueFiles(files: string[]): string[] {
    return files.filter((file, index) => file && files.indexOf(file) === index);
}

function getLineHistoryChangeSymbol(changeKind: LineHistoryChangeKind): string {
    switch (changeKind) {
        case 'R':
            return '↪';
        case 'M':
            return '~';
        case 'A':
            return '+';
        case 'D':
            return '-';
    }
}

function toLineHistoryQuickPickItems(entries: LineHistoryEntry[], cursor: LineHistoryCursor, loadLimit: number): LineHistoryQuickPickItem[] {
    const items = entries.map(entry => toLineHistoryQuickPickItem(entry));
    if (!cursor.done && cursor.loaded >= loadLimit) {
        items.push(toLoadMoreLineHistoryQuickPickItem());
    }

    return items;
}

function toLoadMoreLineHistoryQuickPickItem(): LineHistoryQuickPickItem {
    return {
        label: ' ',
        description: 'Load more...',
        alwaysShow: true,
        command: 'loadMore',
    };
}

function focusLineHistoryEntry(quickPick: vscode.QuickPick<LineHistoryQuickPickItem>, entry: LineHistoryEntry | undefined) {
    if (!entry) {
        return;
    }

    const item = quickPick.items.find(candidate => candidate.entry === entry);
    if (item) {
        quickPick.activeItems = [item];
    }
}

function toLineHistoryQuickPickItem(entry: LineHistoryEntry): LineHistoryQuickPickItem {
    const rawStyle = vscode.workspace.getConfiguration('gitblame').get('dateFormatStyle', defaultDateFormatStyle);
    const activeStyle: DateFormatStyle = VALID_DATEFORMATSTYLES.includes(rawStyle as DateFormatStyle)
        ? (rawStyle as DateFormatStyle)
        : defaultDateFormatStyle;
    const dateStyle: DateFormatStyle = activeStyle === 'relative' ? 'YYYY-MM-DD' : activeStyle;
    const dateText = formatDate(entry.blame.timestamp, dateStyle);
    const lineText = entry.lineText || '(empty line)';
    const changeSymbol = getLineHistoryChangeSymbol(entry.changeKind);

    return {
        label: entry.blame.summary || entry.blame.commit.substring(0, 8),
        description: `${dateText}  ${entry.blame.author}`,
        detail: `${changeSymbol}    ${lineText}`,
        entry,
    };
}
