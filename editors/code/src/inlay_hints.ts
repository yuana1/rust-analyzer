import * as vscode from 'vscode';
import * as lc from 'vscode-languageclient';

import { Ctx, sendRequestWithRetry } from './ctx';

export function activateInlayHints(ctx: Ctx) {
    const hintsUpdater = new HintsUpdater(ctx);
    vscode.window.onDidChangeVisibleTextEditors(
        async _ => hintsUpdater.refresh(),
        null,
        ctx.subscriptions
    );

    vscode.workspace.onDidChangeTextDocument(
        async event => {
            if (event.contentChanges.length !== 0) return;
            if (event.document.languageId !== 'rust') return;
            await hintsUpdater.refresh();
        },
        null,
        ctx.subscriptions
    );

    vscode.workspace.onDidChangeConfiguration(
        async _ => hintsUpdater.setEnabled(ctx.config.displayInlayHints),
        null,
        ctx.subscriptions
    );

    ctx.onDidRestart(_ => hintsUpdater.setEnabled(ctx.config.displayInlayHints));
}

interface InlayHintsParams {
    textDocument: lc.TextDocumentIdentifier;
}

interface InlayHint {
    range: vscode.Range;
    kind: string;
    label: string;
}

const typeHintDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
        color: new vscode.ThemeColor('rust_analyzer.inlayHint'),
    },
});

const parameterHintDecorationType = vscode.window.createTextEditorDecorationType({
    before: {
        color: new vscode.ThemeColor('rust_analyzer.inlayHint'),
    }
});

class HintsUpdater {
    private pending: Map<string, vscode.CancellationTokenSource> = new Map();
    private ctx: Ctx;
    private enabled: boolean;

    constructor(ctx: Ctx) {
        this.ctx = ctx;
        this.enabled = ctx.config.displayInlayHints;
    }

    async setEnabled(enabled: boolean) {
        if (this.enabled == enabled) return;
        this.enabled = enabled;

        if (this.enabled) {
            await this.refresh();
        } else {
            this.allEditors.forEach(it => {
                this.setTypeDecorations(it, []);
                this.setParameterDecorations(it, []);
            });
        }
    }

    async refresh() {
        if (!this.enabled) return;
        const promises = this.allEditors.map(it => this.refreshEditor(it));
        await Promise.all(promises);
    }

    private async refreshEditor(editor: vscode.TextEditor): Promise<void> {
        const newHints = await this.queryHints(editor.document.uri.toString());
        if (newHints == null) return;
        const newTypeDecorations = newHints.filter(hint => hint.kind === 'TypeHint')
            .map(hint => ({
                range: hint.range,
                renderOptions: {
                    after: {
                        contentText: `: ${hint.label}`,
                    },
                },
            }));
        this.setTypeDecorations(editor, newTypeDecorations);

        const newParameterDecorations = newHints.filter(hint => hint.kind === 'ParameterHint')
            .map(hint => ({
                range: hint.range,
                renderOptions: {
                    before: {
                        contentText: `${hint.label}: `,
                    },
                },
            }));
        this.setParameterDecorations(editor, newParameterDecorations);
    }

    private get allEditors(): vscode.TextEditor[] {
        return vscode.window.visibleTextEditors.filter(
            editor => editor.document.languageId === 'rust',
        );
    }

    private setTypeDecorations(
        editor: vscode.TextEditor,
        decorations: vscode.DecorationOptions[],
    ) {
        editor.setDecorations(
            typeHintDecorationType,
            this.enabled ? decorations : [],
        );
    }

    private setParameterDecorations(
        editor: vscode.TextEditor,
        decorations: vscode.DecorationOptions[],
    ) {
        editor.setDecorations(
            parameterHintDecorationType,
            this.enabled ? decorations : [],
        );
    }

    private async queryHints(documentUri: string): Promise<InlayHint[] | null> {
        const client = this.ctx.client;
        if (!client) return null;
        const request: InlayHintsParams = {
            textDocument: { uri: documentUri },
        };
        const tokenSource = new vscode.CancellationTokenSource();
        const prev = this.pending.get(documentUri);
        if (prev) prev.cancel();
        this.pending.set(documentUri, tokenSource);
        try {
            return await sendRequestWithRetry<InlayHint[] | null>(
                client,
                'rust-analyzer/inlayHints',
                request,
                tokenSource.token,
            );
        } finally {
            if (!tokenSource.token.isCancellationRequested) {
                this.pending.delete(documentUri);
            }
        }
    }
}
