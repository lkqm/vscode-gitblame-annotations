# Git Blame Annotations

这是一个 VSCode 插件，用于在编辑器 gutter 区域显示 git blame 信息，类似于 IntelliJ IDEA 的 Annotation With Blame 功能。

## 功能特点

- 在编辑器 gutter 区域显示每行的 git blame 信息
- 鼠标悬停时显示详细的 git blame 信息
- 点击可以查看对应的 git 提交历史

## 使用方法

1. 安装插件后，打开任意 git 仓库中的文件
2. 插件会自动在 gutter 区域显示 git blame 信息
3. 将鼠标悬停在代码行上可以查看更详细的信息
4. 点击详细信息中的链接可以查看完整的提交历史

## 命令

- `Git Blame Annotations: Toggle` - 切换显示/隐藏 git blame 信息

## 配置

在 VSCode 设置中可以配置以下选项：

- `gitblame-annotations.enabled`: 是否启用 git blame 注释（默认为 true）

## 要求

- VSCode 1.80.0 或更高版本
- 工作区必须是 git 仓库 