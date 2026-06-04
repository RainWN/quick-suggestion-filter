import * as vscode from "vscode";

export type LogLevel = "error" | "info" | "debug";

export interface ExtensionConfig {
  enable: boolean;
  logLevel: LogLevel;
}

const defaultConfig: ExtensionConfig = {
  enable: true,
  logLevel: "info",
};

export function loadExtensionConfig(): ExtensionConfig {
  const configuration = vscode.workspace.getConfiguration("quickSuggestionFilter");

  return {
    enable: configuration.get<boolean>("enable", defaultConfig.enable),
    logLevel: configuration.get<LogLevel>("logLevel", defaultConfig.logLevel),
  };
}