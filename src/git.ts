import * as child_process from 'child_process';
import path from 'path';
import { Uri } from 'vscode';

export interface Blame {
    line: number;
    author: string;
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
async function exec(repositoryRoot: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
        const git = child_process.spawn('git', args, { cwd: repositoryRoot });
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
export async function getBlames(repositoryRoot: string, file: string): Promise<Blame[]> {
    const blame = await exec(repositoryRoot, ['blame', '--line-porcelain', file]);
    return parseBlames(blame)
}

/**
 * 获取变更信息
 */
export async function getChanges(repositoryRoot: string, commitId1: string, commitId2?: string): Promise<Change[]> {
    const args = ["diff-tree", "-r", "--name-status", "-z", "--diff-filter=ADMR", commitId1]
    if (commitId2) {
        args.push(commitId2);
    }
    const changes = await exec(repositoryRoot, args);
    return parseChanges(repositoryRoot, changes)
}

/**
 * 获取父提交
 */
export async function getParentCommitId(repositoryRoot: string, commitId: string): Promise<string> {
    try {
        const revId = `${commitId}^`;
        const commit = await exec(repositoryRoot, ["rev-parse", revId]);
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
export async function getEmptyTree(repositoryRoot: string): Promise<string> {
    const result = await exec(repositoryRoot, ['hash-object', '-t', 'tree', '/dev/null']);
    return result.trim();
}

/**
 * 获取文件状态
 */
export async function getFileStatus(repositoryRoot: string, filename: string): Promise<string> {
    const result = await exec(repositoryRoot, ['status', '--short', filename]);
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
 * 解析 blame 信息
 */
function parseBlames(blame: string): Blame[] {
    const blames: Blame[] = []
    const lines = blame.split('\n');

    let currentLine: Blame = {
        line: 0,
        commit: '',
        author: '',
        summary: '',
        timestamp: 0,
        commited: false,
        title: '',
    }
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
                line: parseInt(parts[2]),
                commit: commit,
                author: '',
                summary: '',
                timestamp: 0,
                commited: (commit !== '0000000000000000000000000000000000000000'),
                title: '',
            }
            blames.push(currentLine);
            newLine = false;
        } else if (line.startsWith('author ')) {
            currentLine.author = line.substring(7);
        } else if (line.startsWith('author-time ')) {
            const timestamp = parseInt(line.substring(11));
            currentLine.timestamp = timestamp;
        } else if (line.startsWith('summary ')) {
            currentLine.summary = line.substring(8);
        } else if (line.startsWith('\t')) {
            newLine = true;
        }
    }

    return blames;
}

/**
 * 解析diff-tree变更信息
 */
function parseChanges(repositoryRoot: string, raw: string): Change[] {
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

        const originalUri = Uri.file(path.isAbsolute(resourcePath) ? resourcePath : path.join(repositoryRoot, resourcePath));

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
                uri = renameUri = Uri.file(path.isAbsolute(newPath) ? newPath : path.join(repositoryRoot, newPath));
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