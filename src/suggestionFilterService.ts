import * as vscode from "vscode";
import { ExtensionConfig } from "./config";

export type SuggestionCategoryId =
  | "all"
  | "variable"
  | "method"
  | "snippet"
  | "keyword"
  | "enum"
  | "type"
  | "other";

export type SuggestionCategoryIconId =
  | "all"
  | "variable"
  | "method"
  | "snippet"
  | "keyword"
  | "enum"
  | "type"
  | "other";

export interface SuggestionCategoryTab {
  id: SuggestionCategoryId;
  label: string;
  englishLabel: string;
  icon: SuggestionCategoryIconId;
}

const emptyConfig: ExtensionConfig = {
  enable: true,
  logLevel: "info",
};

const suggestionCategoryTabs: SuggestionCategoryTab[] = [
  { id: "all", label: "全部", englishLabel: "All", icon: "all" },
  { id: "variable", label: "变量", englishLabel: "Variable", icon: "variable" },
  { id: "method", label: "方法", englishLabel: "Method", icon: "method" },
  { id: "snippet", label: "代码段", englishLabel: "Snippet", icon: "snippet" },
  { id: "keyword", label: "关键字", englishLabel: "Keyword", icon: "keyword" },
  { id: "enum", label: "枚举", englishLabel: "Enum", icon: "enum" },
  { id: "type", label: "类型", englishLabel: "Type", icon: "type" },
  { id: "other", label: "其他", englishLabel: "Other", icon: "other" },
];

export class SuggestionFilterService {
  private config: ExtensionConfig = emptyConfig;
  private selectedCategoryId: SuggestionCategoryId = "all";

  public constructor(private readonly outputChannel: vscode.OutputChannel) {}

  public applyConfiguration(config: ExtensionConfig): void {
    this.config = config;
    void vscode.commands.executeCommand(
      "setContext",
      "quickSuggestionFilter.enabled",
      config.enable
    );
    this.log(
      "info",
      `Configuration applied: enabled=${config.enable}`
    );
  }

  public getStatusSummary(): string {
    return [
      "Quick Suggestion Filter status",
      `enabled: ${this.config.enable}`,
      `category: ${this.selectedCategoryId}`,
      "mode: filtered completion command",
    ].join(" | ");
  }

  public isEnabled(): boolean {
    return this.config.enable;
  }

  public getCategoryTabs(): readonly SuggestionCategoryTab[] {
    return suggestionCategoryTabs;
  }

  public getSelectedCategoryId(): SuggestionCategoryId {
    return this.selectedCategoryId;
  }

  public getSelectedCategoryLabel(): string {
    const selectedTab = suggestionCategoryTabs.find(
      (tab) => tab.id === this.selectedCategoryId
    );
    return selectedTab?.label ?? this.selectedCategoryId;
  }

  public setSelectedCategoryId(categoryId: SuggestionCategoryId): boolean {
    if (!suggestionCategoryTabs.some((tab) => tab.id === categoryId)) {
      return false;
    }

    const didChange = this.selectedCategoryId !== categoryId;
    this.selectedCategoryId = categoryId;
    if (didChange) {
      this.log("info", `Suggestion category changed to ${categoryId}.`);
    }
    return didChange;
  }

  public resetSelectedCategoryToAll(): boolean {
    return this.setSelectedCategoryId("all");
  }

  public selectAdjacentCategory(offset: number): boolean {
    const tabs = suggestionCategoryTabs;
    const currentIndex = tabs.findIndex(
      (tab) => tab.id === this.selectedCategoryId
    );
    const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex =
      (safeCurrentIndex + offset + tabs.length * 10) % tabs.length;
    return this.setSelectedCategoryId(tabs[nextIndex].id);
  }

  public logInfo(message: string): void {
    this.log("info", message);
  }

  public logError(message: string): void {
    this.log("error", message);
  }

  private log(level: "error" | "info" | "debug", message: string): void {
    const priorityMap: Record<string, number> = {
      error: 0,
      info: 1,
      debug: 2,
    };

    if (priorityMap[level] > priorityMap[this.config.logLevel]) {
      return;
    }

    this.outputChannel.appendLine(`[${level}] ${message}`);
  }
}