import { format as timeagoFormat } from 'timeago.js';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { Blame, Change } from './git';

// keep the defaults in sync with package.json
export type DateFormatStyle = 'YYYY-MM-DD' | 'Y/M/D' | 'DD.MM.YYYY' | 'relative'
export const VALID_DATEFORMATSTYLES: DateFormatStyle[] = ['YYYY-MM-DD', 'Y/M/D', 'DD.MM.YYYY', 'relative'];
export const defaultDateFormatStyle: DateFormatStyle = 'YYYY-MM-DD'

export type AuthorNameStyle = 'full' | 'first' | 'last'
export const VALID_AUTHORNAMESTYLES: AuthorNameStyle[] = ['full', 'first', 'last'];
export const defaultAuthorNameStyle: AuthorNameStyle = 'full';

export function validateConfigEnum<T extends string>(
	cfg: vscode.WorkspaceConfiguration, 
	VALID_ARR: T[], 
	key: string, 
	fallback: T
): T {
	const raw = cfg.get<string>(key, fallback);
	return VALID_ARR.includes(raw as T) ? (raw as T) : fallback;
}

/**
* @param timestamp timestamp in seconds
*/
export function formatDate(timestamp: number, style: DateFormatStyle): string {
	if (style === 'relative') {
		const locale = vscode.env.language.startsWith('zh') ? 'zh_CN' : 'en_US';
		return timeagoFormat(new Date(timestamp * 1000), locale);
	}

	const date = new Date(timestamp * 1000);
	const map: Record<Exclude<DateFormatStyle, 'relative'>, [string, Intl.DateTimeFormatOptions]> = {
		'YYYY-MM-DD': ['en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }],
		'Y/M/D': ['en-GB', { year: 'numeric', month: 'numeric', day: 'numeric' }],
		'DD.MM.YYYY': ['de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' }],
	};
	const [locale, options] = map[style as Exclude<DateFormatStyle, 'relative'>];
	return new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatAuthor(name: string, style: AuthorNameStyle) {
	if (!name || name.trim() === "") return "";

	const parts = name.split(" ");
	switch (style) {
		case "first": return parts[0];
		case "last": return parts[parts.length - 1];
		case "full":
		default:
			return name;
	}
}

export function toMultiFileDiffEditorUris(change: Change, originalRef: string, modifiedRef: string): { originalUri: Uri | undefined; modifiedUri: Uri | undefined } {
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

export function toGitUri(uri: Uri, ref: string, options: { submoduleOf?: string, replaceFileExtension?: boolean, scheme?: string } = {}): Uri {
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

export function getTextWidth(text: string): { width: number, widths: number[] } {
	let width = 0;
	const widths = [];
	for (const char of text) {
		const w = getCharacterWidth(char);
		widths.push(w);
		width += w;
	}
	return { width, widths };
}

export function getCharacterWidth(char: string): number {
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

export function trancateText(text: string, maxWidth: number, widths: number[]): string {
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

export function getCommitColor(commit: string, timestamp: number): { lightColor: string, darkColor: string } {
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

export function buildUncommitBlame(line: number): Blame {
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

export function resolveChange(change: vscode.TextDocumentContentChangeEvent) {
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