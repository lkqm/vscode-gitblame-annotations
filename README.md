# Git Blame Annotations
Display git blame in editor gutter like JetBrains IDEs.
![main](./images/screenshoot1.png)

## Features
- Display commit information for each line.
- Hover for commit information.
- Click to view commit changes.

## Usage
1. Install `Git Blame Annotations` extension.
2. Right-click menu on line numbers.
3. Click "Annotate with Git Blame" or "Close Annotations".
4. Hover annotation view commit detail.

## Commands
- `git.blame.toggle` - Toggle Annotations (shortcut: ctrl+alt+b)
- `git.blame.show` - Annotate with Git Blame
- `git.blame.hide` - Close Annotations（shortcut: Esc）

## Develop

```
# Run & Debug
npm install
npm run compile

# Build
npm install -g @vscode/vsce
vsce package

# Publish
vsce login <publisher>
vsce publish
```
