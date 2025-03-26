import simpleGit from 'simple-git';
import * as vscode from 'vscode';

interface Blame {
    author: string;
    commit: string;
    line: number;
    summary?: string;
    timestamp?: number;
}


export function activate(context: vscode.ExtensionContext) {
    let decorationType: vscode.TextEditorDecorationType | undefined;
    let hoverProvider: vscode.Disposable | undefined;
    // 用于跟踪每个文件的显示状态
    const fileBlameStates = new Map<string, boolean>();

    const formatDate = (timestamp: number): string => {
        const date = new Date(timestamp * 1000);
        return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
    };

    const formatDateWithTime = (timestamp: number): string => {
        const date = new Date(timestamp * 1000);
        return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    };

    const updateDecorations = async (editor: vscode.TextEditor) => {
        if (!editor) {
            return;
        }

        const document = editor.document;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

        if (!workspaceFolder) {
            return;
        }

        // 检查当前文件是否应该显示 blame
        const shouldShowBlame = fileBlameStates.get(document.fileName);
        if (!shouldShowBlame) {
            // 如果不需要显示，清除装饰器
            if (decorationType) {
                decorationType.dispose();
                decorationType = undefined;
            }
            if (hoverProvider) {
                hoverProvider.dispose();
                hoverProvider = undefined;
            }
            return;
        }

        try {
            const git = simpleGit(workspaceFolder.uri.fsPath);
            // 使用 raw 命令执行 git blame
            const blameResult = await git.raw(['blame', '--line-porcelain', document.fileName]);

            // 解析 blame 输出
            const lines = blameResult.split('\n');
            const blameLines: Array<{ author: string; date: string; commit: string; summary?: string; timestamp?: number; commited: boolean, label: string, code: string }> = [];
            let currentLine: any = {};
            let lineNumber = 0;

            let newLine = true;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (newLine) {
                    let parts = line.split(' ');
                    let commit = parts[0];
                    if (commit == '') {
                        continue;
                    }
                    currentLine = {
                        commit: commit,
                        commited: commit !== '0000000000000000000000000000000000000000',
                    };
                    blameLines.push(currentLine);
                    newLine = false;
                } else if (line.startsWith('author ')) {
                    currentLine.author = line.substring(7);
                } else if (line.startsWith('author-time ')) {
                    const timestamp = parseInt(line.substring(11));
                    currentLine.date = formatDate(timestamp);
                    currentLine.timestamp = timestamp;
                } else if (line.startsWith('summary ')) {
                    currentLine.summary = line.substring(8);
                } else if (line.startsWith('\t')) {
                    currentLine.code = line.substring(1);
                    lineNumber++;
                    newLine = true;
                }
            }


            const decorations: vscode.DecorationOptions[] = [];
            const blameInfoMap = new Map<number, Blame>();

            // 确保 blameLines 数组长度与文档行数匹配
            while (blameLines.length < document.lineCount) {
                blameLines.push(blameLines[blameLines.length - 1] || {
                    author: 'Unknown',
                    date: 'Unknown',
                    commit: 'Unknown',
                    commited: false,
                });
            }
            // 计算已提交行的label格式
            blameLines.forEach(line => {
                if (line.commited) {
                    line.label = `${line.date} ${line.author}`;
                } else {
                    line.label = '·';  // 使用一个可见的占位符字符
                }
            });

            // 找出最长的label长度
            const maxLabelLength = blameLines.reduce((max, line) => {
                if (line.commited && line.label) {
                    return Math.max(max, line.label.length);
                }
                return max;
            }, 0);


            blameLines.forEach((line, index) => {
                const range = new vscode.Range(
                    new vscode.Position(index, 0),
                    new vscode.Position(index, 0)
                );

                const blameInfo: Blame = {
                    line: index + 1,
                    commit: line.commit,
                    author: line.author,
                    timestamp: line.timestamp,
                    summary: line.summary
                };

                blameInfoMap.set(index, blameInfo);

                let paddingSize = maxLabelLength - line.label.length
                decorations.push({
                    range,
                    renderOptions: {
                        before: {
                            contentText: line.label + '·'.repeat(paddingSize),
                            color: line.commited ? '#666666' : '#00000000',
                            margin: '0 1em 0 0'
                        }
                    }
                });
            });

            if (decorationType) {
                decorationType.dispose();
            }

            decorationType = vscode.window.createTextEditorDecorationType({
                before: {
                    color: '#666666',
                    margin: '0 1em 0 0'
                }
            });

            editor.setDecorations(decorationType, decorations);

            // 注册悬停提供器
            if (hoverProvider) {
                hoverProvider.dispose();
            }

            hoverProvider = vscode.languages.registerHoverProvider(
                { scheme: 'file' },
                {
                    provideHover(document: vscode.TextDocument, position: vscode.Position) {
                        // 检查鼠标是否在 gutter 区域内
                        const line = document.lineAt(position.line);
                        const gutterWidth = maxLabelLength + 1; // 加1是为了考虑padding
                        if (position.character > gutterWidth) {
                            return undefined;
                        }

                        const blameInfo = blameInfoMap.get(position.line);
                        if (blameInfo) {
                            const content = new vscode.MarkdownString();
                            content.appendMarkdown(`commit: [${blameInfo.commit}](command:git.showCommit?${encodeURIComponent(JSON.stringify(blameInfo))})\n\n`);
                            content.appendMarkdown(`Author: ${blameInfo.author}\n\n`);
                            content.appendMarkdown(`Date: ${blameInfo.timestamp ? formatDateWithTime(blameInfo.timestamp) : ""}\n\n`);
                            if (blameInfo.summary) {
                                content.appendMarkdown(`${blameInfo.summary}`);
                            }
                            content.isTrusted = true;
                            return new vscode.Hover(content);
                        }
                    }
                }
            );

        } catch (error: any) {
            console.error('Git blame error:', error);
            vscode.window.showErrorMessage(`Git Blame 错误: ${error.message || '未知错误'}`);
        }
    };

    const toggleCommand = vscode.commands.registerCommand('git.blame.toggle', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const currentState = fileBlameStates.get(editor.document.fileName) || false;
            fileBlameStates.set(editor.document.fileName, !currentState);
            updateDecorations(editor);
        }
    });

    const showCommitCommand = vscode.commands.registerCommand('git.showCommit', async (blameInfo: Blame) => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const git = simpleGit(workspaceFolder.uri.fsPath);
            try {
                console.log('Attempting to show commit:', blameInfo.commit);
                // 使用 raw 命令执行 git show
                const commit = await git.raw(['show', blameInfo.commit]);
                console.log('Commit info retrieved successfully');
                const document = await vscode.workspace.openTextDocument({
                    content: commit,
                    language: 'git-commit'
                });
                await vscode.window.showTextDocument(document);
            } catch (error: any) {
                console.error('Error showing commit:', error);
                console.error('Error details:', {
                    message: error.message,
                    stack: error.stack,
                    command: error.command
                });
                vscode.window.showErrorMessage(`查看提交历史失败: ${error.message || '未知错误'}`);
            }
        }
    });

    // 监听文档变化
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === event.document) {
            updateDecorations(editor);
        }
    });

    // 监听编辑器变化
    const changeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            // 根据文件的显示状态决定是否更新装饰器
            const shouldShowBlame = fileBlameStates.get(editor.document.fileName);
            if (shouldShowBlame) {
                updateDecorations(editor);
            } else {
                // 如果不需要显示，清除装饰器
                if (decorationType) {
                    decorationType.dispose();
                    decorationType = undefined;
                }
                if (hoverProvider) {
                    hoverProvider.dispose();
                    hoverProvider = undefined;
                }
            }
        }
    });

    // 监听文档关闭事件
    const closeDocumentSubscription = vscode.workspace.onDidCloseTextDocument(document => {
        // 当文档关闭时，移除其状态
        fileBlameStates.delete(document.fileName);
    });

    context.subscriptions.push(toggleCommand, showCommitCommand, changeDocumentSubscription, changeEditorSubscription, closeDocumentSubscription);

    // 初始化时不显示任何装饰器
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        fileBlameStates.set(editor.document.fileName, false);
    }
}

export function deactivate() { } 