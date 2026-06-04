import * as vscode from "vscode";
import { loadExtensionConfig } from "./config";
import { EditorBottomTabsDecorationController } from "./editorBottomTabsDecorationController";
import { registerFilteredSuggestCommand } from "./filteredSuggestCommand";
import { SuggestKindSettingsController } from "./suggestKindSettingsController";
import { registerSuggestWidgetAutoShowProvider } from "./suggestWidgetAutoShowProvider";
import {
  SuggestionCategoryId,
  SuggestionFilterService,
} from "./suggestionFilterService";

let suggestKindSettingsController: SuggestKindSettingsController | undefined;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Quick Suggestion Filter");
  const filterService = new SuggestionFilterService(outputChannel);
  suggestKindSettingsController = new SuggestKindSettingsController(
    context,
    outputChannel
  );
  const editorBottomTabsDecorationController =
    new EditorBottomTabsDecorationController(filterService, suggestKindSettingsController);

  const applyConfiguration = async (): Promise<void> => {
    filterService.applyConfiguration(loadExtensionConfig());
    await suggestKindSettingsController?.syncCategory(
      filterService.isEnabled(),
      filterService.getSelectedCategoryId()
    );
    editorBottomTabsDecorationController.hide();
  };

  await suggestKindSettingsController.initialize();
  await applyConfiguration();
  outputChannel.appendLine("[info] Quick Suggestion Filter activated.");

  context.subscriptions.push(outputChannel);
  context.subscriptions.push(editorBottomTabsDecorationController);
  context.subscriptions.push({
    dispose: () => {
      void suggestKindSettingsController?.openAllSettingsForDeactivation();
    },
  });

  registerFilteredSuggestCommand(
    context,
    filterService,
    editorBottomTabsDecorationController,
    suggestKindSettingsController,
    outputChannel
  );

  registerSuggestWidgetAutoShowProvider(
    context,
    filterService,
    suggestKindSettingsController,
    editorBottomTabsDecorationController
  );

  const cycleCategoryAndRefreshSuggest = async (offset: number): Promise<void> => {
    const didChange = filterService.selectAdjacentCategory(offset);
    if (!didChange || !filterService.isEnabled() || !vscode.window.activeTextEditor) {
      return;
    }

    editorBottomTabsDecorationController.showImmediate();

    await vscode.commands.executeCommand(
      "quickSuggestionFilter.triggerFilteredSuggest",
      true
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "quickSuggestionFilter.hideSuggestAndTabs",
      async () => {
        editorBottomTabsDecorationController.hide();
        try {
          await vscode.commands.executeCommand("hideSuggestWidget");
        } catch {
          // Ignore if the suggest widget is already hidden.
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "quickSuggestionFilter.selectPreviousCategory",
      async () => {
        await cycleCategoryAndRefreshSuggest(-1);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "quickSuggestionFilter.selectNextCategory",
      async () => {
        await cycleCategoryAndRefreshSuggest(1);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "quickSuggestionFilter.selectCategory",
      async (categoryId: SuggestionCategoryId) => {
        const isKnownCategory = filterService
          .getCategoryTabs()
          .some((tab) => tab.id === categoryId);

        if (!isKnownCategory) {
          return;
        }

        filterService.setSelectedCategoryId(categoryId);
        if (!filterService.isEnabled() || !vscode.window.activeTextEditor) {
          return;
        }

        await vscode.commands.executeCommand(
          "quickSuggestionFilter.triggerFilteredSuggest",
          true
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("quickSuggestionFilter")) {
        return;
      }

      await applyConfiguration();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("quickSuggestionFilter.showStatus", async () => {
      const message = filterService.getStatusSummary();
      outputChannel.appendLine(`[info] ${message}`);
      await vscode.window.showInformationMessage(message);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "quickSuggestionFilter.reloadConfiguration",
      async () => {
        await applyConfiguration();
        await vscode.window.showInformationMessage(
          "Quick Suggestion Filter configuration reloaded."
        );
      }
    )
  );
}

export function deactivate(): void {
  if (!suggestKindSettingsController) {
    return;
  }

  void suggestKindSettingsController.openAllSettingsForDeactivation();
  suggestKindSettingsController = undefined;
}