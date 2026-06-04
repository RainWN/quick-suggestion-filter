import * as vscode from "vscode";
import { EditorBottomTabsDecorationController } from "./editorBottomTabsDecorationController";
import { SuggestKindSettingsController } from "./suggestKindSettingsController";
import { SuggestionFilterService } from "./suggestionFilterService";

const suggestWidgetDocumentSelector: vscode.DocumentSelector = [
  { scheme: "file" },
  { scheme: "untitled" },
  { scheme: "vscode-userdata" },
];

export function registerSuggestWidgetAutoShowProvider(
  context: vscode.ExtensionContext,
  filterService: SuggestionFilterService,
  suggestKindSettingsController: SuggestKindSettingsController,
  editorBottomTabsDecorationController: EditorBottomTabsDecorationController
): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      suggestWidgetDocumentSelector,
      {
        provideCompletionItems(document, position, token) {
          if (token.isCancellationRequested || !filterService.isEnabled()) {
            return undefined;
          }

          const activeEditor = vscode.window.activeTextEditor;
          if (!activeEditor || activeEditor.document !== document) {
            return undefined;
          }

          setTimeout(() => {
            if (token.isCancellationRequested || !filterService.isEnabled()) {
              return;
            }

            const currentEditor = vscode.window.activeTextEditor;
            if (!currentEditor || currentEditor.document !== document) {
              return;
            }

            editorBottomTabsDecorationController.show(position);
          }, 0);

          void suggestKindSettingsController
            .syncCategory(
              filterService.isEnabled(),
              filterService.getSelectedCategoryId()
            )
            .catch(() => undefined);
          return undefined;
        },
      },
      "."
    )
  );
}