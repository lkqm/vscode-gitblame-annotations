import path from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { Blame, Change, getBlameLine, getChanges, getEmptyTree, getGitRepository, getParentCommitIds } from './git';
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
    entry: LineHistoryEntry,
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

export interface ShowLineHistoryOptions {
    fileName: string,
    lineNumber?: number,
    ref?: string,
    repositoryRoot?: string,
    activeDocument?: vscode.TextDocument,
}

const LineHistoryPageSize = 10;
const MaxLineHistoryEntries = 200;

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
            vscode.window.showInformationMessage('No committed history found for this line.');
            return;
        }

        const quickPick = vscode.window.createQuickPick<LineHistoryQuickPickItem>();
        quickPick.title = `Line History: ${path.basename(fileName)}:${lineNumber}`;
        quickPick.placeholder = 'Select a revision to compare this file';
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.items = entries.map(entry => toLineHistoryQuickPickItem(entry));
        quickPick.buttons = [];
        quickPick.busy = !cursor.done;
        let disposed = false;

        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0];
            quickPick.hide();
            if (selected) {
                await openLineHistoryFileDiff(selected.entry, repositoryRoot!);
            }
        });

        quickPick.onDidTriggerItemButton(async event => {
            const button = event.button as vscode.QuickInputButton & { action?: string };
            const entry = event.item.entry;

            if (button.action === 'copyHash') {
                await vscode.env.clipboard.writeText(entry.blame.commit);
                vscode.window.showInformationMessage('Commit hash copied.');
                return;
            }

            if (button.action === 'openCommit') {
                quickPick.hide();
                await vscode.commands.executeCommand('git.blame.viewCommit', entry.blame.commit, entry.blame.summary, entry.fileName);
            }
        });

        quickPick.onDidHide(() => {
            disposed = true;
            quickPick.dispose();
        });
        quickPick.show();

        void loadRemainingLineHistory(repositoryRoot, cursor, entries, quickPick, activeDocument, () => disposed);
    } catch (error: any) {
        vscode.window.showErrorMessage(`${error.message}`);
    }
}

async function loadRemainingLineHistory(
    repositoryRoot: string,
    cursor: LineHistoryCursor,
    entries: LineHistoryEntry[],
    quickPick: vscode.QuickPick<LineHistoryQuickPickItem>,
    activeDocument: vscode.TextDocument | undefined,
    isDisposed: () => boolean
) {
    try {
        while (!isDisposed() && !cursor.done) {
            quickPick.busy = true;
            const nextEntries = await loadLineHistoryBatch(repositoryRoot, cursor, activeDocument);
            if (nextEntries.length === 0) {
                break;
            }

            entries.push(...nextEntries);
            if (!isDisposed()) {
                quickPick.items = entries.map(entry => toLineHistoryQuickPickItem(entry));
            }
        }
    } catch (error: any) {
        if (!isDisposed()) {
            vscode.window.showErrorMessage(`${error.message}`);
        }
    } finally {
        if (!isDisposed()) {
            quickPick.busy = false;
        }
    }
}

async function openLineHistoryFileDiff(entry: LineHistoryEntry, repositoryRoot: string) {
    const commitId = entry.blame.commit;
    const diffTarget = await resolveLineHistoryDiffTarget(repositoryRoot, entry);

    const title = `${commitId.substring(0, 7)} - ${path.basename(entry.fileName)}`;
    if (diffTarget.resource.originalUri && diffTarget.resource.modifiedUri) {
        await vscode.commands.executeCommand('vscode.diff', diffTarget.resource.originalUri, diffTarget.resource.modifiedUri, title, { preview: false });
        return;
    }

    const multiDiffSourceUri = Uri.from({ scheme: 'scm-history-item', path: `${repositoryRoot}/${diffTarget.parentCommitId}..${commitId}/${entry.fileName}` });
    await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
        multiDiffSourceUri,
        title,
        resources: [diffTarget.resource],
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

    while (!cursor.done && entries.length < LineHistoryPageSize && cursor.loaded < MaxLineHistoryEntries) {
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
        const lineText = getActiveDocumentLineText(cursor.currentFileName, cursor.currentLineNumber, cursor.currentRef, activeDocument) ?? blameLine.lineText.trim();
        entries.push({
            blame,
            fileName: cursor.currentFileName,
            lineNumber: cursor.currentLineNumber,
            lineText,
            changeKind: getLineHistoryChangeKind(repositoryRoot, cursor.currentFileName, blame),
        });
        cursor.loaded++;

        if (!blame.previousCommit) {
            cursor.done = true;
            break;
        }

        cursor.currentRef = blame.previousCommit;
        cursor.currentFileName = resolveHistoricalFileName(repositoryRoot, cursor.currentFileName, blame.previousFile);
        cursor.currentLineNumber = blame.sourceLine || cursor.currentLineNumber;
    }

    if (cursor.loaded >= MaxLineHistoryEntries) {
        cursor.done = true;
    }

    return entries;
}

async function getBlameLineAtLine(repositoryRoot: string, fileName: string, lineNumber: number, ref?: string) {
    const blameFile = getRepositoryRelativePath(repositoryRoot, fileName);
    return getBlameLine(repositoryRoot, blameFile, lineNumber, ref);
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

function getLineHistoryChangeKind(repositoryRoot: string, currentFileName: string, blame: Blame): LineHistoryChangeKind {
    if (!blame.previousCommit) {
        return 'A';
    }

    if (blame.previousFile) {
        const previousFileName = resolveHistoricalFileName(repositoryRoot, currentFileName, blame.previousFile);
        if (!isSamePath(previousFileName, currentFileName)) {
            return 'R';
        }
    }

    return 'M';
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
        buttons: [
            {
                iconPath: new vscode.ThemeIcon('copy'),
                tooltip: 'Copy Commit Hash',
                action: 'copyHash',
            } as vscode.QuickInputButton & { action: string },
            {
                iconPath: new vscode.ThemeIcon('git-commit'),
                tooltip: 'Open Full Commit',
                action: 'openCommit',
            } as vscode.QuickInputButton & { action: string },
        ],
    };
}
