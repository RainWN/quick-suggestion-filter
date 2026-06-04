import * as vscode from "vscode";
import { EditorBottomTabsDecorationController } from "./editorBottomTabsDecorationController";
import { SuggestKindSettingsController } from "./suggestKindSettingsController";
import { SuggestionFilterService } from "./suggestionFilterService";

export function registerFilteredSuggestCommand(
  context: vscode.ExtensionContext,
  filterService: SuggestionFilterService,
  editorBottomTabsDecorationController: EditorBottomTabsDecorationController,
  suggestKindSettingsController: SuggestKindSettingsController,
  outputChannel: vscode.OutputChannel
): void {
  let isTriggeringFilteredSuggest = false;
  let hasPendingFilteredSuggest = false;
  let pendingRestartSuggestWidget = false;

  const runTriggerFilteredSuggest = async (
    restartSuggestWidget?: boolean
  ): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.window.showWarningMessage("No active editor found.");
      return;
    }

    const targetCategoryId = filterService.getSelectedCategoryId();

    try {
      const pendingOperations: Promise<unknown>[] = [
        suggestKindSettingsController.syncCategory(
          filterService.isEnabled(),
          targetCategoryId
        ),
      ];

      if (restartSuggestWidget) {
        pendingOperations.push(hideSuggestWidget(outputChannel));
      }

      await Promise.all(pendingOperations);

      if (hasPendingFilteredSuggest) {
        editorBottomTabsDecorationController.refresh();
        return;
      }

      filterService.logInfo(
        `Triggering native suggest for category=${targetCategoryId}.`
      );
      await vscode.commands.executeCommand("editor.action.triggerSuggest");
      editorBottomTabsDecorationController.show();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[error] Native suggest trigger failed: ${message}`);
      filterService.logError(`Native suggest trigger failed: ${message}`);
      await vscode.window.showErrorMessage(
        `Quick Suggestion Filter failed: ${message}`
      );
    }
  };

  const queueTriggerFilteredSuggest = async (
    restartSuggestWidget?: boolean
  ): Promise<void> => {
    hasPendingFilteredSuggest = true;
    pendingRestartSuggestWidget =
      pendingRestartSuggestWidget || restartSuggestWidget === true;

    if (isTriggeringFilteredSuggest) {
      return;
    }

    isTriggeringFilteredSuggest = true;
    let isSuggestWidgetRestarting = false;
    try {
      while (hasPendingFilteredSuggest) {
        const shouldRestartSuggestWidget = pendingRestartSuggestWidget;
        hasPendingFilteredSuggest = false;
        pendingRestartSuggestWidget = false;

        if (shouldRestartSuggestWidget && !isSuggestWidgetRestarting) {
          editorBottomTabsDecorationController.beginSuggestWidgetRestart();
          isSuggestWidgetRestarting = true;
        }

        await runTriggerFilteredSuggest(shouldRestartSuggestWidget);
      }
    } finally {
      if (isSuggestWidgetRestarting) {
        editorBottomTabsDecorationController.endSuggestWidgetRestart();
      }

      isTriggeringFilteredSuggest = false;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "quickSuggestionFilter.triggerFilteredSuggest",
      async (restartSuggestWidget?: boolean) => {
        await queueTriggerFilteredSuggest(restartSuggestWidget);
      }
    )
  );
}

async function hideSuggestWidget(
  outputChannel: vscode.OutputChannel
): Promise<void> {
  try {
    await vscode.commands.executeCommand("hideSuggestWidget");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(
      `[debug] Failed to hide suggest widget before retrigger: ${message}`
    );
  }
}
