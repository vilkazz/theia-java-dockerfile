/********************************************************************************
 * Copyright (C) 2018 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable, inject } from 'inversify';
import { Widget } from '@phosphor/widgets';
import { FrontendApplicationContribution, WidgetOpenerOptions, NavigatableWidgetOpenHandler } from '@theia/core/lib/browser';
import { EditorManager, TextEditor, EditorWidget, EditorContextMenu } from '@theia/editor/lib/browser';
import { DisposableCollection, CommandContribution, CommandRegistry, Command, MenuContribution, MenuModelRegistry, Disposable } from '@theia/core/lib/common';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import URI from '@theia/core/lib/common/uri';
import { Position } from 'vscode-languageserver-types';
import { PreviewWidget } from './preview-widget';
import { PreviewHandlerProvider, } from './preview-handler';
import { PreviewUri } from './preview-uri';
import { PreviewPreferences } from './preview-preferences';

import debounce = require('lodash.debounce');

export namespace PreviewCommands {
    /**
     * No `label`. Otherwise, it would show up in the `Command Palette` and we already have the `Preview` open handler.
     * See in (`WorkspaceCommandContribution`)[https://bit.ly/2DncrSD].
     */
    export const OPEN: Command = {
        id: 'preview:open',
        label: 'Open Preview'
    };
    export const OPEN_SOURCE: Command = {
        id: 'preview.open.source'
    };
}

export interface PreviewOpenerOptions extends WidgetOpenerOptions {
    originUri?: URI;
}

@injectable()
// tslint:disable-next-line:max-line-length
export class PreviewContribution extends NavigatableWidgetOpenHandler<PreviewWidget> implements CommandContribution, MenuContribution, FrontendApplicationContribution, TabBarToolbarContribution {

    readonly id = PreviewUri.id;
    readonly label = 'Preview';

    @inject(EditorManager)
    protected readonly editorManager: EditorManager;

    @inject(PreviewHandlerProvider)
    protected readonly previewHandlerProvider: PreviewHandlerProvider;

    @inject(PreviewPreferences)
    protected readonly preferences: PreviewPreferences;

    protected readonly synchronizedUris = new Set<string>();

    onStart() {
        this.onCreated(previewWidget => {
            this.registerOpenOnDoubleClick(previewWidget);
            this.registerEditorAndPreviewSync(previewWidget);
        });
        this.editorManager.onCreated(editorWidget => {
            this.registerEditorAndPreviewSync(editorWidget);
        });
    }

    protected async registerEditorAndPreviewSync(source: PreviewWidget | EditorWidget): Promise<void> {
        let uri: string;
        let editorWidget: EditorWidget | undefined;
        let previewWidget: PreviewWidget | undefined;
        if (source instanceof EditorWidget) {
            editorWidget = source;
            uri = editorWidget.editor.uri.toString();
            previewWidget = await this.getWidget(editorWidget.editor.uri);
        } else {
            previewWidget = source;
            uri = previewWidget.getUri().toString();
            editorWidget = await this.editorManager.getByUri(previewWidget.getUri());
        }
        if (!previewWidget || !editorWidget || !uri) {
            return;
        }
        if (this.synchronizedUris.has(uri)) {
            return;
        }
        const syncDisposables = new DisposableCollection();
        previewWidget.disposed.connect(() => syncDisposables.dispose());
        editorWidget.disposed.connect(() => syncDisposables.dispose());

        const editor = editorWidget.editor;
        syncDisposables.push(editor.onCursorPositionChanged(debounce(position => this.revealSourceLineInPreview(previewWidget!, position)), 100));
        syncDisposables.push(this.synchronizeScrollToEditor(previewWidget, editor));

        this.synchronizedUris.add(uri);
        syncDisposables.push(Disposable.create(() => this.synchronizedUris.delete(uri)));
    }

    protected revealSourceLineInPreview(previewWidget: PreviewWidget, position: Position): void {
        previewWidget.revealForSourceLine(position.line);
    }

    protected synchronizeScrollToEditor(previewWidget: PreviewWidget, editor: TextEditor): Disposable {
        return previewWidget.onDidScroll(sourceLine => {
            const line = Math.floor(sourceLine);
            editor.revealRange({
                start: {
                    line,
                    character: 0
                },
                end: {
                    line: line + 1,
                    character: 0
                }
            }, { at: 'top' });
        });
    }

    protected registerOpenOnDoubleClick(ref: PreviewWidget): void {
        const disposable = ref.onDidDoubleClick(async location => {
            const { editor } = await this.openSource(ref);
            editor.revealPosition(location.range.start);
            editor.selection = location.range;
            ref.revealForSourceLine(location.range.start.line);
        });
        ref.disposed.connect(() => disposable.dispose());
    }

    canHandle(uri: URI): number {
        if (!this.previewHandlerProvider.canHandle(uri)) {
            return 0;
        }
        const editorPriority = this.editorManager.canHandle(uri);
        if (editorPriority === 0) {
            return 200;
        }
        if (PreviewUri.match(uri)) {
            return editorPriority * 2;
        }
        return editorPriority * (this.openByDefault ? 2 : 0.5);
    }

    protected get openByDefault(): boolean {
        return this.preferences['preview.openByDefault'];
    }

    async open(uri: URI, options?: PreviewOpenerOptions): Promise<PreviewWidget> {
        const resolvedOptions = await this.resolveOpenerOptions(options);
        return super.open(uri, resolvedOptions);
    }
    protected serializeUri(uri: URI): string {
        return super.serializeUri(PreviewUri.decode(uri));
    }

    protected async resolveOpenerOptions(options?: PreviewOpenerOptions): Promise<PreviewOpenerOptions> {
        const resolved: PreviewOpenerOptions = { mode: 'activate', ...options };
        if (resolved.originUri) {
            const ref = await this.getWidget(resolved.originUri);
            if (ref) {
                resolved.widgetOptions = { ...resolved.widgetOptions, ref };
            }
        }
        return resolved;
    }

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(PreviewCommands.OPEN, {
            execute: widget => this.openForEditor(widget),
            isEnabled: widget => this.canHandleEditorUri(widget),
            isVisible: widget => this.canHandleEditorUri(widget)
        });
        registry.registerCommand(PreviewCommands.OPEN_SOURCE, {
            execute: widget => this.openSource(widget),
            isEnabled: widget => widget instanceof PreviewWidget,
            isVisible: widget => widget instanceof PreviewWidget
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(EditorContextMenu.NAVIGATION, {
            commandId: PreviewCommands.OPEN.id
        });
    }

    registerToolbarItems(registry: TabBarToolbarRegistry): void {
        registry.registerItem({
            id: PreviewCommands.OPEN.id,
            command: PreviewCommands.OPEN.id,
            text: '$(eye)',
            tooltip: 'Open Preview to the Side'
        });
        registry.registerItem({
            id: PreviewCommands.OPEN_SOURCE.id,
            command: PreviewCommands.OPEN_SOURCE.id,
            text: '$(file-o)',
            tooltip: 'Open Source'
        });
    }

    protected canHandleEditorUri(widget?: Widget): boolean {
        const uri = this.getCurrentEditorUri(widget);
        return !!uri && this.previewHandlerProvider.canHandle(uri);
    }

    protected getCurrentEditorUri(widget?: Widget): URI | undefined {
        const current = this.getCurrentEditor(widget);
        return current && current.editor.uri;
    }

    protected getCurrentEditor(widget?: Widget): EditorWidget | undefined {
        const current = widget ? widget : this.editorManager.currentEditor;
        return current instanceof EditorWidget && current || undefined;
    }

    protected async openForEditor(widget?: Widget): Promise<void> {
        const ref = this.getCurrentEditor(widget);
        if (!ref) {
            return;
        }
        await this.open(ref.editor.uri, {
            mode: 'reveal',
            widgetOptions: { ref, mode: 'open-to-right' }
        });
    }

    protected async openSource(ref: PreviewWidget): Promise<EditorWidget>;
    protected async openSource(ref?: Widget): Promise<EditorWidget | undefined> {
        if (ref instanceof PreviewWidget) {
            return this.editorManager.open(ref.uri, {
                widgetOptions: { ref, mode: 'open-to-left' }
            });
        }
    }

}