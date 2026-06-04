import * as vscode from "vscode";
import { SuggestionCategoryId } from "./suggestionFilterService";

type SuggestSettingKey =
  | "showMethods"
  | "showFunctions"
  | "showConstructors"
  | "showFields"
  | "showVariables"
  | "showClasses"
  | "showStructs"
  | "showInterfaces"
  | "showModules"
  | "showProperties"
  | "showEvents"
  | "showOperators"
  | "showUnits"
  | "showValues"
  | "showConstants"
  | "showEnums"
  | "showEnumMembers"
  | "showKeywords"
  | "showWords"
  | "showColors"
  | "showFiles"
  | "showReferences"
  | "showFolders"
  | "showTypeParameters"
  | "showSnippets"
  | "showUsers"
  | "showIssues";

type SuggestSettingSnapshot = Record<SuggestSettingKey, boolean | undefined>;

const managedSuggestSettingKeys: SuggestSettingKey[] = [
  "showMethods",
  "showFunctions",
  "showConstructors",
  "showFields",
  "showVariables",
  "showClasses",
  "showStructs",
  "showInterfaces",
  "showModules",
  "showProperties",
  "showEvents",
  "showOperators",
  "showUnits",
  "showValues",
  "showConstants",
  "showEnums",
  "showEnumMembers",
  "showKeywords",
  "showWords",
  "showColors",
  "showFiles",
  "showReferences",
  "showFolders",
  "showTypeParameters",
  "showSnippets",
  "showUsers",
  "showIssues",
];

const categoryVisibilityCache = new Map<SuggestionCategoryId, SuggestSettingSnapshot>();

function getDefaultVisibility(value: boolean | undefined): SuggestSettingSnapshot {
  const snapshot = {} as SuggestSettingSnapshot;
  for (let index = 0; index < managedSuggestSettingKeys.length; index += 1) {
    snapshot[managedSuggestSettingKeys[index]] = value;
  }
  return snapshot;
}

function buildCategoryVisibility(
  categoryId: SuggestionCategoryId
): SuggestSettingSnapshot {
  const cached = categoryVisibilityCache.get(categoryId);
  if (cached) {
    return cached;
  }

  const visibility = getDefaultVisibility(false);

  switch (categoryId) {
    case "snippet":
      visibility.showSnippets = true;
      break;
    case "keyword":
      visibility.showKeywords = true;
      break;
    case "method":
      visibility.showMethods = true;
      visibility.showFunctions = true;
      visibility.showConstructors = true;
      break;
    case "variable":
      visibility.showVariables = true;
      visibility.showFields = true;
      visibility.showProperties = true;
      visibility.showConstants = true;
      visibility.showValues = true;
      break;
    case "enum":
      visibility.showEnums = true;
      visibility.showEnumMembers = true;
      break;
    case "type":
      visibility.showClasses = true;
      visibility.showStructs = true;
      visibility.showInterfaces = true;
      visibility.showTypeParameters = true;
      break;
    case "other":
      visibility.showModules = true;
      visibility.showEvents = true;
      visibility.showOperators = true;
      visibility.showUnits = true;
      visibility.showWords = true;
      visibility.showColors = true;
      visibility.showFiles = true;
      visibility.showReferences = true;
      visibility.showFolders = true;
      visibility.showUsers = true;
      visibility.showIssues = true;
      break;
    default:
      break;
  }

  categoryVisibilityCache.set(categoryId, visibility);
  return visibility;
}

const originalSettingsStateKey = "quickSuggestionFilter.originalSuggestSettings";

export class SuggestKindSettingsController {
  private originalSettings?: SuggestSettingSnapshot;
  private currentSettingsSnapshot?: SuggestSettingSnapshot;
  private appliedMode: SuggestionCategoryId | "all" = "all";
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  public async initialize(): Promise<void> {
    await this.runExclusive(async () => {
      await this.restorePersistedOriginalSettingsCore();
      if (!this.currentSettingsSnapshot) {
        this.currentSettingsSnapshot = this.captureCurrentSettings();
      }
      this.appliedMode = "all";
    });
  }

  public async syncCategory(
    enabled: boolean,
    categoryId: SuggestionCategoryId,
    skipApiSync = false
  ): Promise<void> {
    await this.runExclusive(async () => {
      if (!enabled) {
        await this.restoreOriginalSettingsCore();
        return;
      }

      await this.applyCategoryCore(categoryId, skipApiSync);
    });
  }

  public async applyCategory(categoryId: SuggestionCategoryId): Promise<void> {
    await this.runExclusive(() => this.applyCategoryCore(categoryId));
  }

  public async restoreOriginalSettings(): Promise<void> {
    await this.runExclusive(() => this.restoreOriginalSettingsCore());
  }

  public async openAllSettingsForDeactivation(): Promise<void> {
    await this.runExclusive(() => this.openAllSettingsForDeactivationCore());
  }

  private async applyCategoryCore(
    categoryId: SuggestionCategoryId,
    skipApiSync = false
  ): Promise<void> {
    if (categoryId === "all") {
      await this.applyAllCategoryCore(skipApiSync);
      return;
    }

    if (this.appliedMode === categoryId) {
      return;
    }

    await this.ensureOriginalSettingsCaptured();
    await this.updateSettings(buildCategoryVisibility(categoryId), skipApiSync);
    this.appliedMode = categoryId;
    this.outputChannel.appendLine(
      `[info] Applied native suggest category visibility: ${categoryId}`
    );
  }

  private async applyAllCategoryCore(skipApiSync = false): Promise<void> {
    const allVisibility = getDefaultVisibility(true);
    if (
      this.appliedMode === "all" &&
      this.currentSettingsSnapshot &&
      this.areSnapshotsEqual(this.currentSettingsSnapshot, allVisibility)
    ) {
      return;
    }

    await this.ensureOriginalSettingsCaptured();
    await this.updateSettings(allVisibility, skipApiSync);
    this.appliedMode = "all";
    this.outputChannel.appendLine(
      "[info] Applied native suggest category visibility: all"
    );
  }

  private async restoreOriginalSettingsCore(): Promise<void> {
    const settingsToRestore =
      this.originalSettings ?? (await this.readPersistedOriginalSettings());
    if (!settingsToRestore) {
      this.appliedMode = "all";
      if (!this.currentSettingsSnapshot) {
        this.currentSettingsSnapshot = this.captureCurrentSettings();
      }
      return;
    }

    if (
      this.appliedMode !== "all" ||
      !this.currentSettingsSnapshot ||
      !this.areSnapshotsEqual(this.currentSettingsSnapshot, settingsToRestore)
    ) {
      await this.updateSettings(settingsToRestore);
      this.outputChannel.appendLine("[info] Restored original native suggest settings.");
    }

    this.appliedMode = "all";
    this.originalSettings = undefined;
    await this.context.globalState.update(originalSettingsStateKey, undefined);
  }

  private async openAllSettingsForDeactivationCore(): Promise<void> {
    await this.ensureOriginalSettingsCaptured();
    await this.updateSettings(getDefaultVisibility(true));
    this.appliedMode = "all";
    this.outputChannel.appendLine(
      "[info] Opened all native suggest categories for deactivation."
    );
  }

  private async ensureOriginalSettingsCaptured(): Promise<void> {
    if (this.originalSettings) {
      return;
    }

    this.originalSettings = this.currentSettingsSnapshot ?? this.captureCurrentSettings();
    await this.context.globalState.update(
      originalSettingsStateKey,
      this.originalSettings
    );
  }

  private captureCurrentSettings(): SuggestSettingSnapshot {
    const configuration = vscode.workspace.getConfiguration("editor.suggest");
    const snapshot = {} as SuggestSettingSnapshot;
    for (let index = 0; index < managedSuggestSettingKeys.length; index += 1) {
      const key = managedSuggestSettingKeys[index];
      const inspected = configuration.inspect<boolean>(key);
      snapshot[key] = inspected?.workspaceValue ?? inspected?.globalValue;
    }
    return snapshot;
  }

  private async updateSettings(
    snapshot: SuggestSettingSnapshot,
    skipApiSync = false
  ): Promise<void> {
    const currentSnapshot = this.currentSettingsSnapshot ?? this.captureCurrentSettings();
    const changedKeys: [string, boolean | undefined][] = [];
    for (let index = 0; index < managedSuggestSettingKeys.length; index += 1) {
      const key = managedSuggestSettingKeys[index];
      if (currentSnapshot[key] === snapshot[key]) {
        continue;
      }

      changedKeys.push([key, snapshot[key]]);
    }

    this.currentSettingsSnapshot = { ...snapshot };
    if (changedKeys.length === 0) {
      return;
    }

    await this.writeSettingsFile(changedKeys);
    if (!skipApiSync) {
      const configuration = vscode.workspace.getConfiguration("editor.suggest");
      await configuration.update(
        changedKeys[0][0],
        changedKeys[0][1],
        vscode.ConfigurationTarget.Workspace
      );
    }
  }

  private async writeSettingsFile(
    changedKeys: [string, boolean | undefined][]
  ): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      const configuration = vscode.workspace.getConfiguration("editor.suggest");
      await Promise.all(
        changedKeys.map(([key, value]) =>
          configuration.update(key, value, vscode.ConfigurationTarget.Global)
        )
      );
      return;
    }

    const vscodeDir = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode");
    const settingsUri = vscode.Uri.joinPath(vscodeDir, "settings.json");

    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(settingsUri))
      );
    } catch {
      try { await vscode.workspace.fs.createDirectory(vscodeDir); } catch {}
    }

    for (let i = 0; i < changedKeys.length; i += 1) {
      const flatKey = `editor.suggest.${changedKeys[i][0]}`;
      if (changedKeys[i][1] === undefined) delete settings[flatKey];
      else settings[flatKey] = changedKeys[i][1];
    }

    await vscode.workspace.fs.writeFile(
      settingsUri,
      new TextEncoder().encode(JSON.stringify(settings, null, 2))
    );
  }

  private async restorePersistedOriginalSettingsCore(): Promise<void> {
    const persistedSettings = await this.readPersistedOriginalSettings();
    if (!persistedSettings) {
      return;
    }

    await this.updateSettings(persistedSettings);
    this.appliedMode = "all";
    await this.context.globalState.update(originalSettingsStateKey, undefined);
    this.outputChannel.appendLine(
      "[info] Restored persisted native suggest settings from previous session."
    );
  }

  private async readPersistedOriginalSettings(): Promise<
    SuggestSettingSnapshot | undefined
  > {
    return this.context.globalState.get<SuggestSettingSnapshot | undefined>(
      originalSettingsStateKey
    );
  }

  private areSnapshotsEqual(
    left: SuggestSettingSnapshot,
    right: SuggestSettingSnapshot
  ): boolean {
    for (let index = 0; index < managedSuggestSettingKeys.length; index += 1) {
      const key = managedSuggestSettingKeys[index];
      if (left[key] !== right[key]) {
        return false;
      }
    }

    return true;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const nextOperation = this.operationQueue.then(operation, operation);
    this.operationQueue = nextOperation.then(
      () => undefined,
      () => undefined
    );
    return nextOperation;
  }
}