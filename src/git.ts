import * as child_process from 'child_process';
import path from 'path';
import { Uri } from 'vscode';

export interface Blame {
    line: number;
    author: string;
    mail: string;
    commit: string;
    summary: string;
    timestamp: number;
    commited: boolean;
    title: string;
}

export interface CommitBlame {
    lines: [number, number][];
    author: string;
    mail: string;
    commit: string;
    summary: string;
    timestamp: number;
    commited: boolean;
    title: string;
}

export interface Change {
    readonly uri: Uri;
    readonly originalUri: Uri;
    readonly renameUri: Uri | undefined;
    readonly status: string;
}

/**
 * 执行git命令
 */
async function exec(workDir: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
        const git = child_process.spawn('git', args, { cwd: workDir });
        let stdout = '';
        let stderr = '';

        git.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        git.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        git.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Git command failed with code ${code}: ${stderr}`));
                return;
            }
            resolve(stdout);
        });

        git.on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * 获取文件路径对应的git仓库目录
 */
export async function getGitRepository(filePath: string): Promise<string> {
    const dir = path.dirname(filePath);
    try {
        const result = await exec(dir, ['rev-parse', '--show-toplevel']);
        return result.trim();
    } catch (error) {
        return "";
    }
}


/**
 * 获取文件的 blame 信息
 */
export async function getBlames(workDir: string, file: string): Promise<Blame[]> {
    const blame = await exec(workDir, ['blame', '--incremental', file]);
    const { totalLines, blames } = parseBlames(blame);
    return toBlames(totalLines, blames);
}

/**
 * 获取变更信息
 */
export async function getChanges(workDir: string, commitId1: string, commitId2?: string): Promise<Change[]> {
    const args = ["diff-tree", "-r", "--name-status", "-z", "--diff-filter=ADMR", commitId1];
    if (commitId2) {
        args.push(commitId2);
    }
    const changes = await exec(workDir, args);
    return parseChanges(workDir, changes);
}

/**
 * 获取父提交
 */
export async function getParentCommitId(workDir: string, commitId: string): Promise<string> {
    try {
        const revId = `${commitId}^`;
        const commit = await exec(workDir, ["rev-parse", revId]);
        let parentId = commit.trim();
        if (parentId === commitId) {
            parentId = "";
        }
        return parentId;
    } catch (error) {
        return "";
    }
}

/**
 * 获取空树
 */
export async function getEmptyTree(workDir: string): Promise<string> {
    const result = await exec(workDir, ['hash-object', '-t', 'tree', '/dev/null']);
    return result.trim();
}

/**
 * 获取文件状态
 */
export async function getFileStatus(workDir: string, filename: string): Promise<string> {
    const result = await exec(workDir, ['status', '--short', filename]);
    if (!result) {
        return "tracked";
    }
    const statusCode = result.substring(0, 1).trim();
    if (statusCode === "?") {
        return "untracked";
    } else if (statusCode === "A") {
        return "index_add";
    } else {
        return "tracked";
    }
}

/**
 * 解析增量 blame 信息
 */

function parseBlames(blame: string): { totalLines: number, blames: CommitBlame[] } {
    const blames: CommitBlame[] = [];
    const lines = blame.split('\n');

    let currentBlock: CommitBlame = {
        lines: [],
        author: '',
        mail: '',
        commit: '',
        summary: '',
        timestamp: 0,
        commited: false,
        title: '',
    };
    const commitToBlock = new Map<string, CommitBlame>();
    let newBlock = true;
    let totalLines = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (newBlock) {
            let parts = line.split(' ');
            let commit = parts[0];
            if (commit === '') {
                continue;
            }
            const commitBlock = commitToBlock.get(commit);
            const lineNumber = parseInt(parts[2]);
            const lineCount = parseInt(parts[3]);
            if (commitBlock) {
                commitBlock.lines.push([lineNumber, lineCount]);
                currentBlock = commitBlock;
            } else {
                currentBlock = {
                    lines: [[lineNumber, lineCount]],
                    commit: commit,
                    author: '',
                    mail: '',
                    summary: '',
                    timestamp: 0,
                    commited: (commit !== '0000000000000000000000000000000000000000'),
                    title: '',
                };
                blames.push(currentBlock);
                commitToBlock.set(commit, currentBlock);
            }
            newBlock = false;
            // calculate total lines
            const endLineNumber = lineNumber + lineCount - 1;
            if (endLineNumber > totalLines) {
                totalLines = endLineNumber;
            }
        } else if (line.startsWith('author ')) {
            currentBlock.author = line.substring(7);
        } else if (line.startsWith('author-mail ')) {
            currentBlock.mail = line.substring(12);
        } else if (line.startsWith('author-time ')) {
            const timestamp = parseInt(line.substring(11));
            currentBlock.timestamp = timestamp;
        } else if (line.startsWith('summary ')) {
            currentBlock.summary = line.substring(8);
        } else if (line.startsWith('filename ')) {
            newBlock = true;
        }
    }
    return { totalLines, blames };
}

/**
 * 解析diff-tree变更信息
 */
function parseChanges(workDir: string, raw: string): Change[] {
    let index = 0;
    const result: Change[] = [];
    const segments = raw.trim().split('\x00').filter(s => s);

    segmentsLoop:
    while (index < segments.length - 1) {
        const change = segments[index++];
        const resourcePath = segments[index++];

        if (!change || !resourcePath) {
            break;
        }

        const originalUri = Uri.file(path.isAbsolute(resourcePath) ? resourcePath : path.join(workDir, resourcePath));

        let uri = originalUri;
        let renameUri = originalUri;
        let status = "untracked";

        // Copy or Rename status comes with a number (ex: 'R100').
        // We don't need the number, we use only first character of the status.
        switch (change[0]) {
            case 'A':
                status = "index_added";
                break;

            case 'M':
                status = "modified";
                break;

            case 'D':
                status = "deleted";
                break;

            // Rename contains two paths, the second one is what the file is renamed/copied to.
            case 'R': {
                if (index >= segments.length) {
                    break;
                }

                const newPath = segments[index++];
                if (!newPath) {
                    break;
                }

                status = "index_renamed";
                uri = renameUri = Uri.file(path.isAbsolute(newPath) ? newPath : path.join(workDir, newPath));
                break;
            }
            default:
                // Unknown status
                break segmentsLoop;
        }

        result.push({ status, uri, originalUri, renameUri });
    }

    return result;
}

function toBlames(totalLines: number, commitBlames: CommitBlame[]): Blame[] {
    const blames: Blame[] = new Array(totalLines);
    commitBlames.forEach(({ lines, ...commitInfo }) => {
        lines.forEach(([start, length]) => {
            const end = start + length - 1;
            for (let i = start - 1; i < end; i++) {
                blames[i] = {
                    line: i + 1,
                    ...commitInfo
                };
            }
        });
    });
    return blames;
}
