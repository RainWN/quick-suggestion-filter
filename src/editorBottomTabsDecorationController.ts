import * as vscode from "vscode";
import {
  SuggestionCategoryIconId,
  SuggestionFilterService,
} from "./suggestionFilterService";

interface TabsBarPalette {
  background: string;
  border: string;
  foreground: string;
  mutedForeground: string;
  selectedBackground: string;
  selectedBorder: string;
  selectedForeground: string;
}

interface TabsBarRenderData {
  uri: vscode.Uri;
  widthPx: number;
  heightPx: number;
}

interface TriggerAnchorState {
  documentUri: string;
  position: vscode.Position;
}

interface VisibleLineSlotsInfo {
  currentVisibleLineSlots: number;
  maxVisibleLineSlots: number;
  compensationLineSlots: number;
  effectiveVisibleLineSlots: number;
}

export class EditorBottomTabsDecorationController implements vscode.Disposable {
  private static readonly frameDetectionIntervalMs = 16;
  private static readonly barPaddingX = 10;
  private static readonly barPaddingY = 5;
  private static readonly tabWidth = 70;
  private static readonly tabHeight = 36;
  private static readonly tabGap = 4;
  private readonly topTabsDecorationType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    before: {
      margin: "-0.1rem 0 0 0",
    },
  });
  private readonly subscriptions: vscode.Disposable[] = [];
  private isVisible = false;
  private isSuggestRestarting = false;
  private tabsVisibleContext = false;
  private refreshTimer?: NodeJS.Timeout;
  private lateRefreshTimer?: NodeJS.Timeout;
  private layoutRefreshIntervalTimer?: NodeJS.Timeout;
  private layoutRefreshSyncTimer?: NodeJS.Timeout;
  private tabsBarCacheKey?: string;
  private tabsBarCacheData?: TabsBarRenderData;
  private triggerAnchorState?: TriggerAnchorState;
  private pinnedVerticalOffsetPx?: number;
  private pinnedViewportTopLine?: number;
  private viewportCapacityLayoutKey?: string;
  private maxVisibleLineSlots?: number;
  private lastAppliedLayoutKey?: string;

  public constructor(private readonly filterService: SuggestionFilterService) {
    this.setTabsVisibleContext(false);

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      this.updateViewportCapacityHistory(activeEditor);
    }

    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.updateViewportCapacityHistory(editor);
        }

        if (this.isVisible) {
          this.hide();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (!this.isVisible || event.textEditor !== vscode.window.activeTextEditor) {
          return;
        }

        if (this.isSuggestRestarting) {
          return;
        }

        if (
          event.kind === vscode.TextEditorSelectionChangeKind.Keyboard ||
          event.kind === vscode.TextEditorSelectionChangeKind.Command
        ) {
          this.scheduleTabsLayoutRefresh(0);
          return;
        }

        this.hide();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.isVisible && vscode.window.activeTextEditor?.document === event.document) {
          this.scheduleTabsLayoutRefresh(0);
          this.refresh();
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        if (event.textEditor !== vscode.window.activeTextEditor) {
          return;
        }

        this.updateViewportCapacityHistory(event.textEditor);
        if (this.isVisible) {
          this.updatePinnedOffsetForViewportChange(event.textEditor);
          this.refresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        const activeEditor = vscode.window.activeTextEditor;
        const affectsViewportLayout =
          event.affectsConfiguration("editor.fontSize", activeEditor?.document) ||
          event.affectsConfiguration("editor.lineHeight", activeEditor?.document) ||
          event.affectsConfiguration("editor.padding", activeEditor?.document) ||
          event.affectsConfiguration("window.zoomLevel");

        if (!affectsViewportLayout) {
          return;
        }

        this.resetViewportCapacityHistory(activeEditor);
        this.invalidateTabsBarCache();
        if (this.isVisible && activeEditor) {
          this.pinVerticalOffset(activeEditor);
          this.refresh();
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.invalidateTabsBarCache();
        if (this.isVisible) {
          this.refresh();
        }
      })
    );
  }

  public show(anchorPosition?: vscode.Position): void {
    const wasVisible = this.isVisible;
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      this.updateViewportCapacityHistory(activeEditor);
      this.captureTriggerAnchor(
        activeEditor,
        anchorPosition ?? this.getActiveAnchorPosition(activeEditor)
      );
      if (!wasVisible) {
        this.pinVerticalOffset(activeEditor);
      }
    }

    if (!this.filterService.isEnabled()) {
      this.hide({ resetCategory: false });
      return;
    }

    this.isVisible = true;
    this.setTabsVisibleContext(true);
    this.refresh();
    if (!wasVisible) {
      this.scheduleRefresh(0);
      this.scheduleLateRefresh(48);
      this.startLayoutRefreshInterval();
      return;
    }

    this.scheduleLateRefresh(24);
  }

  public beginSuggestWidgetRestart(): void {
    this.isSuggestRestarting = true;
  }

  public endSuggestWidgetRestart(): void {
    this.isSuggestRestarting = false;
  }

  public hide(options?: { resetCategory?: boolean }): void {
    this.isVisible = false;
    this.triggerAnchorState = undefined;
    this.pinnedVerticalOffsetPx = undefined;
    this.pinnedViewportTopLine = undefined;
    this.lastAppliedLayoutKey = undefined;
    this.setTabsVisibleContext(false);
    this.clearRefreshTimers();
    this.clearTabsLayoutRefreshInterval();
    this.clearTabsLayoutRefreshTimer();
    this.clearTopTabsDecorations();

    if (options?.resetCategory !== false && !this.isSuggestRestarting) {
      this.filterService.resetSelectedCategoryToAll();
    }
  }

  public refresh(): void {
    const editor = vscode.window.activeTextEditor;

    if (!this.isVisible || !editor || !this.filterService.isEnabled()) {
      this.clearTopTabsDecorations();
      return;
    }

    this.applyTopTabsDecoration(editor);
  }

  public dispose(): void {
    this.hide();

    for (let index = 0; index < this.subscriptions.length; index += 1) {
      this.subscriptions[index].dispose();
    }
    this.topTabsDecorationType.dispose();
  }

  private applyTopTabsDecoration(editor: vscode.TextEditor): void {
    const verticalOffsetPx = this.getPinnedVerticalOffsetPx(editor);
    const anchorRange = this.getAnchorRange(editor);
    const anchorLine = anchorRange.start.line;
    const layoutKey = [
      this.filterService.getSelectedCategoryId(),
      vscode.window.activeColorTheme.kind,
      anchorLine,
      verticalOffsetPx,
    ].join("|");

    if (this.lastAppliedLayoutKey === layoutKey) {
      return;
    }

    const tabsBarRenderData = this.getTabsBarRenderData(verticalOffsetPx);
    const layoutCancelWidthPx = tabsBarRenderData.widthPx;
    this.lastAppliedLayoutKey = layoutKey;
    this.clearTopTabsDecorations(editor);
    editor.setDecorations(this.topTabsDecorationType, [
      {
        range: anchorRange,
        hoverMessage: new vscode.MarkdownString(
          `当前补全分类：**${this.filterService.getSelectedCategoryLabel()}**`
        ),
        renderOptions: {
          before: {
            contentIconPath: tabsBarRenderData.uri,
            margin: `-0.1rem -${layoutCancelWidthPx}px 0 0`,
            textDecoration:
              "none; display: inline-block; position: relative; z-index: 2147483647; pointer-events: none; transform: translateX(0.9rem); vertical-align: top;",
            width: `${tabsBarRenderData.widthPx}px`,
            height: `${tabsBarRenderData.heightPx}px`,
          },
        },
      },
    ]);
  }

  private getTabsBarRenderData(verticalOffsetPx: number): TabsBarRenderData {
    const cacheKey = `${this.filterService.getSelectedCategoryId()}|${vscode.window.activeColorTheme.kind}|${verticalOffsetPx}`;
    if (this.tabsBarCacheKey === cacheKey && this.tabsBarCacheData) {
      return this.tabsBarCacheData;
    }

    const tabs = this.filterService.getCategoryTabs();
    const palette = this.getTabsBarPalette();
    const baseHeightPx = this.getVisualTabsBarHeightPx();
    const widthPx =
      EditorBottomTabsDecorationController.barPaddingX * 2 +
      tabs.length * EditorBottomTabsDecorationController.tabWidth +
      (tabs.length - 1) * EditorBottomTabsDecorationController.tabGap;
    const heightPx = verticalOffsetPx + baseHeightPx;
    const selectedCategoryId = this.filterService.getSelectedCategoryId();

    const tabsMarkup: string[] = [];
    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index];
      const tabX =
        EditorBottomTabsDecorationController.barPaddingX +
        index *
          (EditorBottomTabsDecorationController.tabWidth +
            EditorBottomTabsDecorationController.tabGap);
      const tabY = verticalOffsetPx + EditorBottomTabsDecorationController.barPaddingY;
      const isSelected = tab.id === selectedCategoryId;
      const iconColor = isSelected
        ? palette.selectedForeground
        : palette.foreground;
      const labelColor = isSelected
        ? palette.selectedForeground
        : palette.mutedForeground;

      if (isSelected) {
        tabsMarkup.push(
          `<rect x="${tabX}" y="${tabY}" width="${EditorBottomTabsDecorationController.tabWidth}" height="${EditorBottomTabsDecorationController.tabHeight}" rx="10" fill="${palette.selectedBackground}" stroke="${palette.selectedBorder}" stroke-width="1.2" />`
        );
      }

      tabsMarkup.push(
        this.renderTabIcon(
          tab.icon,
          tabX + EditorBottomTabsDecorationController.tabWidth / 2,
          tabY + 12,
          iconColor
        )
      );
      tabsMarkup.push(
        `<text x="${tabX + EditorBottomTabsDecorationController.tabWidth / 2}" y="${tabY + 29}" text-anchor="middle" font-size="10.5" font-family="Segoe UI, Arial, sans-serif" font-weight="${isSelected ? "700" : "600"}" fill="${labelColor}">${this.escapeXml(tab.englishLabel)}</text>`
      );
    }

    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}" fill="none">`,
      `<rect x="0.5" y="${verticalOffsetPx + 0.5}" width="${widthPx - 1}" height="${baseHeightPx - 1}" rx="16" fill="${palette.background}" stroke="${palette.border}" />`,
      ...tabsMarkup,
      "</svg>",
    ].join("");
    const svgBase64 = Buffer.from(svg, "utf8").toString("base64");
    const renderData: TabsBarRenderData = {
      uri: vscode.Uri.parse(`data:image/svg+xml;base64,${svgBase64}`),
      widthPx,
      heightPx,
    };

    this.tabsBarCacheKey = cacheKey;
    this.tabsBarCacheData = renderData;
    return renderData;
  }

  private getVisualTabsBarHeightPx(): number {
    return (
      EditorBottomTabsDecorationController.barPaddingY * 2 +
      EditorBottomTabsDecorationController.tabHeight
    );
  }

  private getTabsBarPalette(): TabsBarPalette {
    switch (vscode.window.activeColorTheme.kind) {
      case vscode.ColorThemeKind.Light:
        return {
          background: "#f6f8fb",
          border: "#d3dbe5",
          foreground: "#23527c",
          mutedForeground: "#4b5b6b",
          selectedBackground: "#0078d4",
          selectedBorder: "#0b5cab",
          selectedForeground: "#ffffff",
        };
      case vscode.ColorThemeKind.HighContrast:
      case vscode.ColorThemeKind.HighContrastLight:
        return {
          background: "#000000",
          border: "#f0f0f0",
          foreground: "#f0f0f0",
          mutedForeground: "#f0f0f0",
          selectedBackground: "#0f4a85",
          selectedBorder: "#ffff00",
          selectedForeground: "#ffffff",
        };
      default:
        return {
          background: "#202225",
          border: "#4a4f57",
          foreground: "#8cd6ff",
          mutedForeground: "#c4ced8",
          selectedBackground: "#094771",
          selectedBorder: "#3794ff",
          selectedForeground: "#ffffff",
        };
    }
  }

  private renderTabIcon(
    iconId: SuggestionCategoryIconId,
    centerX: number,
    centerY: number,
    color: string
  ): string {
    switch (iconId) {
      case "all":
        return [
          `<g transform="translate(${centerX} ${centerY})" fill="${color}">`,
          '<rect x="-7" y="-7" width="5" height="5" rx="1.2" />',
          '<rect x="2" y="-7" width="5" height="5" rx="1.2" />',
          '<rect x="-7" y="2" width="5" height="5" rx="1.2" />',
          '<rect x="2" y="2" width="5" height="5" rx="1.2" />',
          "</g>",
        ].join("");
      case "variable":
        return [
          `<g transform="translate(${centerX} ${centerY})" stroke="${color}" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`,
          '<rect x="-6.5" y="-6.5" width="13" height="13" rx="3" />',
          `<circle cx="0" cy="0" r="1.8" fill="${color}" stroke="none" />`,
          "</g>",
        ].join("");
      case "method":
        return [
          `<g transform="translate(${centerX} ${centerY})" stroke="${color}" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`,
          '<path d="M-5 -2.5L0 4L5 -2.5" />',
          '<circle cx="-5" cy="-2.5" r="1.8" />',
          '<circle cx="0" cy="4" r="1.8" />',
          '<circle cx="5" cy="-2.5" r="1.8" />',
          "</g>",
        ].join("");
      case "snippet":
        return [
          `<g transform="translate(${centerX} ${centerY})" stroke="${color}" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">`,
          '<path d="M-5.5 -6H1L5.5 -1.5V6H-5.5Z" />',
          '<path d="M1 -6V-1.5H5.5" />',
          '<path d="M-2.5 -1.5L-4 0L-2.5 1.5" />',
          '<path d="M2.5 -1.5L4 0L2.5 1.5" />',
          "</g>",
        ].join("");
      case "keyword":
        return [
          `<g transform="translate(${centerX} ${centerY})" stroke="${color}" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`,
          '<circle cx="-2.5" cy="0" r="3.4" />',
          '<path d="M0.5 0H6" />',
          '<path d="M4 0V2" />',
          '<path d="M5.8 0V1.3" />',
          "</g>",
        ].join("");
      case "enum":
        return [
          `<g transform="translate(${centerX} ${centerY})" stroke="${color}" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`,
          `<circle cx="-5.5" cy="-4" r="1" fill="${color}" stroke="none" />`,
          `<circle cx="-5.5" cy="0" r="1" fill="${color}" stroke="none" />`,
          `<circle cx="-5.5" cy="4" r="1" fill="${color}" stroke="none" />`,
          '<path d="M-2.5 -4H5.5" />',
          '<path d="M-2.5 0H5.5" />',
          '<path d="M-2.5 4H5.5" />',
          "</g>",
        ].join("");
      case "type":
        return [
          `<g transform="translate(${centerX} ${centerY})" stroke="${color}" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">`,
          '<path d="M0 -7L5.5 -4V3L0 6L-5.5 3V-4Z" />',
          '<path d="M0 -7V0" />',
          '<path d="M-5.5 -4L0 0L5.5 -4" />',
          "</g>",
        ].join("");
      case "other":
      default:
        return [
          `<g transform="translate(${centerX} ${centerY})" fill="${color}">`,
          '<circle cx="-4.5" cy="0" r="1.5" />',
          '<circle cx="0" cy="0" r="1.5" />',
          '<circle cx="4.5" cy="0" r="1.5" />',
          "</g>",
        ].join("");
    }
  }

  private invalidateTabsBarCache(): void {
    this.tabsBarCacheKey = undefined;
    this.tabsBarCacheData = undefined;
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  private getAnchorRange(editor: vscode.TextEditor): vscode.Range {
    const document = editor.document;
    const anchorLine = this.getViewportAnchorLine(editor);
    const safeAnchorLine = Math.min(
      Math.max(anchorLine, 0),
      Math.max(document.lineCount - 1, 0)
    );
    const line = document.lineAt(safeAnchorLine);
    if (line.text.length > 0) {
      return new vscode.Range(safeAnchorLine, 0, safeAnchorLine, 1);
    }

    if (!line.rangeIncludingLineBreak.isEmpty) {
      return line.rangeIncludingLineBreak;
    }

    return new vscode.Range(safeAnchorLine, 0, safeAnchorLine, 0);
  }

  private getViewportAnchorLine(editor: vscode.TextEditor): number {
    if (this.pinnedViewportTopLine !== undefined) {
      return this.getNearestVisibleLine(editor, this.pinnedViewportTopLine);
    }

    if (editor.visibleRanges.length > 0) {
      return editor.visibleRanges[0].start.line;
    }

    const anchorPosition = this.getActiveAnchorPosition(editor);
    return editor.document.validatePosition(anchorPosition).line;
  }

  private captureTriggerAnchor(
    editor: vscode.TextEditor,
    anchorPosition: vscode.Position
  ): void {
    this.triggerAnchorState = {
      documentUri: editor.document.uri.toString(),
      position: editor.document.validatePosition(anchorPosition),
    };
  }

  private getActiveAnchorPosition(editor: vscode.TextEditor): vscode.Position {
    if (
      this.triggerAnchorState &&
      this.triggerAnchorState.documentUri === editor.document.uri.toString()
    ) {
      return editor.document.validatePosition(this.triggerAnchorState.position);
    }

    return editor.selection.active;
  }

  private getVerticalOffsetPx(editor: vscode.TextEditor): number {
    const lineHeightPx = this.getEffectiveLineHeight(editor);
    const visibleLineSlotsInfo = this.getStableVisibleLineSlotsInfo(editor);
    const bottomPaddingPx = this.getEditorBottomPaddingPx(editor);
    return Math.max(
      0,
      Math.round(
        visibleLineSlotsInfo.effectiveVisibleLineSlots * lineHeightPx -
          this.getVisualTabsBarHeightPx() -
          bottomPaddingPx
      )
    );
  }

  private getPinnedVerticalOffsetPx(editor: vscode.TextEditor): number {
    if (this.pinnedVerticalOffsetPx === undefined) {
      this.pinVerticalOffset(editor);
    }

    return this.pinnedVerticalOffsetPx ?? 0;
  }

  private pinVerticalOffset(editor: vscode.TextEditor): void {
    this.updateViewportCapacityHistory(editor);
    this.pinnedVerticalOffsetPx = this.getVerticalOffsetPx(editor);
    this.pinnedViewportTopLine = this.getTopVisibleLine(editor);
    this.lastAppliedLayoutKey = undefined;
  }

  private updatePinnedOffsetForViewportChange(editor: vscode.TextEditor): void {
    const topVisibleLine = this.getTopVisibleLine(editor);
    if (this.pinnedViewportTopLine === topVisibleLine) {
      return;
    }

    this.pinVerticalOffset(editor);
  }

  private getTopVisibleLine(editor: vscode.TextEditor): number {
    if (editor.visibleRanges.length === 0) {
      return editor.selection.active.line;
    }

    return editor.visibleRanges[0].start.line;
  }

  private getNearestVisibleLine(
    editor: vscode.TextEditor,
    targetLine: number
  ): number {
    const visibleRanges = editor.visibleRanges;
    if (visibleRanges.length === 0) {
      return targetLine;
    }

    let nearestLine = visibleRanges[0].start.line;
    for (let index = 0; index < visibleRanges.length; index += 1) {
      const range = visibleRanges[index];
      if (targetLine < range.start.line) {
        return range.start.line;
      }

      if (targetLine <= range.end.line) {
        return targetLine;
      }

      nearestLine = range.end.line;
    }

    return nearestLine;
  }

  private getVisibleLineSlots(editor: vscode.TextEditor): number {
    const visibleRanges = editor.visibleRanges;
    if (visibleRanges.length === 0) {
      return 1;
    }

    let visibleLineSlots = 0;
    for (let index = 0; index < visibleRanges.length; index += 1) {
      const range = visibleRanges[index];
      const startLine = range.start.line;
      const endLineExclusive = Math.max(startLine + 1, range.end.line);
      visibleLineSlots += endLineExclusive - startLine;
    }

    return Math.max(1, visibleLineSlots);
  }

  private getStableVisibleLineSlotsInfo(
    editor: vscode.TextEditor
  ): VisibleLineSlotsInfo {
    this.updateViewportCapacityHistory(editor);
    const currentVisibleLineSlots = this.getVisibleLineSlots(editor);
    const maxVisibleLineSlots = Math.max(
      currentVisibleLineSlots,
      this.maxVisibleLineSlots ?? currentVisibleLineSlots
    );
    const compensationLineSlots = Math.max(
      0,
      maxVisibleLineSlots - currentVisibleLineSlots
    );

    return {
      currentVisibleLineSlots,
      maxVisibleLineSlots,
      compensationLineSlots,
      effectiveVisibleLineSlots: currentVisibleLineSlots + compensationLineSlots,
    };
  }

  private updateViewportCapacityHistory(editor: vscode.TextEditor): void {
    const currentVisibleLineSlots = this.getVisibleLineSlots(editor);
    const layoutKey = this.getViewportCapacityLayoutKey(editor);
    if (this.viewportCapacityLayoutKey !== layoutKey) {
      this.viewportCapacityLayoutKey = layoutKey;
      this.maxVisibleLineSlots = currentVisibleLineSlots;
      return;
    }

    if (
      this.maxVisibleLineSlots === undefined ||
      currentVisibleLineSlots > this.maxVisibleLineSlots
    ) {
      this.maxVisibleLineSlots = currentVisibleLineSlots;
    }
  }

  private resetViewportCapacityHistory(editor?: vscode.TextEditor): void {
    this.viewportCapacityLayoutKey = undefined;
    this.maxVisibleLineSlots = undefined;
    if (editor) {
      this.updateViewportCapacityHistory(editor);
    }
  }

  private getViewportCapacityLayoutKey(editor: vscode.TextEditor): string {
    const zoomLevel = vscode.workspace
      .getConfiguration("window")
      .get<number>("zoomLevel", 0);
    return [
      editor.document.uri.toString(),
      editor.viewColumn ?? -1,
      this.getEffectiveLineHeight(editor),
      this.getEditorBottomPaddingPx(editor),
      zoomLevel,
    ].join("|");
  }

  private getEffectiveLineHeight(editor: vscode.TextEditor): number {
    const editorConfiguration = vscode.workspace.getConfiguration(
      "editor",
      editor.document.uri
    );
    const configuredLineHeight = editorConfiguration.get<number>("lineHeight", 0);
    const fontSize = editorConfiguration.get<number>("fontSize", 14);
    if (configuredLineHeight > 8) {
      return configuredLineHeight;
    }

    if (configuredLineHeight > 0) {
      return Math.round(fontSize * configuredLineHeight);
    }

    return Math.max(fontSize + 8, Math.round(fontSize * 1.5));
  }

  private getEditorBottomPaddingPx(editor: vscode.TextEditor): number {
    const editorConfiguration = vscode.workspace.getConfiguration(
      "editor",
      editor.document.uri
    );
    const padding = editorConfiguration.get<{ bottom?: number }>("padding");
    const bottomPadding = padding?.bottom ?? 0;
    return Math.max(0, bottomPadding);
  }

  private clearTopTabsDecorations(skipEditor?: vscode.TextEditor): void {
    const editors = vscode.window.visibleTextEditors;
    for (let index = 0; index < editors.length; index += 1) {
      const editor = editors[index];
      if (skipEditor && editor === skipEditor) {
        continue;
      }

      editor.setDecorations(this.topTabsDecorationType, []);
    }
  }

  private startLayoutRefreshInterval(): void {
    if (this.layoutRefreshIntervalTimer) {
      return;
    }

    this.layoutRefreshIntervalTimer = setInterval(() => {
      this.refreshVisibleTabsLayout();
    }, EditorBottomTabsDecorationController.frameDetectionIntervalMs);
  }

  private scheduleTabsLayoutRefresh(delayMs: number): void {
    if (this.layoutRefreshSyncTimer) {
      clearTimeout(this.layoutRefreshSyncTimer);
    }

    this.layoutRefreshSyncTimer = setTimeout(() => {
      this.layoutRefreshSyncTimer = undefined;
      this.refreshVisibleTabsLayout();
    }, delayMs);
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, delayMs);
  }

  private scheduleLateRefresh(delayMs: number): void {
    if (this.lateRefreshTimer) {
      clearTimeout(this.lateRefreshTimer);
    }

    this.lateRefreshTimer = setTimeout(() => {
      this.lateRefreshTimer = undefined;
      this.refresh();
    }, delayMs);
  }

  private refreshVisibleTabsLayout(): void {
    if (!this.isVisible || this.isSuggestRestarting) {
      return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      this.updateViewportCapacityHistory(activeEditor);
      this.updatePinnedOffsetForViewportChange(activeEditor);
    }

    this.refresh();
  }

  private clearRefreshTimers(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    if (this.lateRefreshTimer) {
      clearTimeout(this.lateRefreshTimer);
      this.lateRefreshTimer = undefined;
    }
  }

  private clearTabsLayoutRefreshInterval(): void {
    if (!this.layoutRefreshIntervalTimer) {
      return;
    }

    clearInterval(this.layoutRefreshIntervalTimer);
    this.layoutRefreshIntervalTimer = undefined;
  }

  private clearTabsLayoutRefreshTimer(): void {
    if (!this.layoutRefreshSyncTimer) {
      return;
    }

    clearTimeout(this.layoutRefreshSyncTimer);
    this.layoutRefreshSyncTimer = undefined;
  }

  private setTabsVisibleContext(isVisible: boolean): void {
    if (this.tabsVisibleContext === isVisible) {
      return;
    }

    this.tabsVisibleContext = isVisible;
    void vscode.commands.executeCommand(
      "setContext",
      "quickSuggestionFilter.tabsVisible",
      isVisible
    );
  }
}