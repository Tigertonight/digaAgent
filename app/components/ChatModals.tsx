"use client";

import FileBrowser from "./FileBrowser";
import SkillsPanel from "./SkillsPanel";
import ToolsPanel from "./ToolsPanel";
import AuthPanel from "./AuthPanel";
import ModelsConfigPanel from "./ModelsConfigPanel";
import { ProviderSetupWizard } from "./ProviderSetupWizard";
import BranchesPopover from "./BranchesPopover";
import ImageLightbox from "./ImageLightbox";
import { SystemPromptModal } from "./SystemPromptModal";

interface ChatModalsState {
  showCwdPicker: boolean;
  showFilePicker: boolean;
  showSkills: boolean;
  showTools: boolean;
  showProviderSetup: boolean;
  showAuth: boolean;
  authInitialProvider?: string | null;
  showModelsConfig: boolean;
  providerSetupChild?: "auth" | "models" | null;
  showSystemPrompt: boolean;
  systemPromptText: string | null;
  showBranches: boolean;
}

interface ChatModalsProps {
  // shared
  cwd: string;
  agentId: string | null;
  state: ChatModalsState;
  // CwdPicker
  onCloseCwdPicker: () => void;
  onPickCwd: (picked: string) => void;
  // FilePicker
  onCloseFilePicker: () => void;
  onPickFile: (absPath: string) => void;
  // Skills
  onCloseSkills: () => void;
  // Tools
  onCloseTools: () => void;
  // Provider setup
  onCloseProviderSetup: () => void;
  onProviderSetupOpenAuth: (provider?: string) => void;
  onProviderSetupOpenModelsConfig: () => void;
  // Auth
  onCloseAuth: () => void;
  onBackFromAuth?: () => void;
  onAuthChanged: () => void;
  // ModelsConfig
  onCloseModelsConfig: () => void;
  onBackFromModelsConfig?: () => void;
  onModelsConfigChanged: () => void;
  // SystemPrompt
  onCloseSystemPrompt: () => void;
  // Branches
  onCloseBranches: () => void;
  onBranchesNavigated: () => void;
}

export function ChatModals({
  cwd,
  agentId,
  state,
  onCloseCwdPicker,
  onPickCwd,
  onCloseFilePicker,
  onPickFile,
  onCloseSkills,
  onCloseTools,
  onCloseProviderSetup,
  onProviderSetupOpenAuth,
  onProviderSetupOpenModelsConfig,
  onCloseAuth,
  onBackFromAuth,
  onAuthChanged,
  onCloseModelsConfig,
  onBackFromModelsConfig,
  onModelsConfigChanged,
  onCloseSystemPrompt,
  onCloseBranches,
  onBranchesNavigated,
}: ChatModalsProps) {
  const {
    showCwdPicker,
    showFilePicker,
    showSkills,
    showTools,
    showProviderSetup,
    showAuth,
    authInitialProvider,
    showModelsConfig,
    providerSetupChild,
    showSystemPrompt,
    systemPromptText,
    showBranches,
  } = state;

  return (
    <>
      {showCwdPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "var(--color-overlay)" }}
          onClick={onCloseCwdPicker}
        >
          <div
            className="rounded-md overflow-hidden flex flex-col"
            style={{
              width: 520,
              maxWidth: "90vw",
              height: 520,
              maxHeight: "85vh",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-modal)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <FileBrowser
              initialPath={cwd || "/"}
              onClose={onCloseCwdPicker}
              onPickDir={onPickCwd}
              mode="picker"
            />
          </div>
        </div>
      )}
      {showFilePicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "var(--color-overlay)" }}
          onClick={onCloseFilePicker}
        >
          <div
            className="rounded-md overflow-hidden flex flex-col"
            style={{
              width: 520,
              maxWidth: "90vw",
              height: 520,
              maxHeight: "85vh",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-modal)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <FileBrowser
              initialPath={cwd || "/"}
              onClose={onCloseFilePicker}
              onPickPath={onPickFile}
              mode="picker"
            />
          </div>
        </div>
      )}
      {showSkills && <SkillsPanel cwd={cwd} onClose={onCloseSkills} />}
      {showTools && agentId && (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          style={{ background: "var(--color-overlay)" }}
          onClick={onCloseTools}
        >
          <div
            className="h-full w-[480px] max-w-[90vw] shadow-xl"
            style={{ background: "var(--bg-panel)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <ToolsPanel agentId={agentId} onClose={onCloseTools} />
          </div>
        </div>
      )}
      {showProviderSetup && (
        <ProviderSetupWizard
          onClose={onCloseProviderSetup}
          onOpenAuth={onProviderSetupOpenAuth}
          onOpenModelsConfig={onProviderSetupOpenModelsConfig}
        />
      )}
      {showAuth && (
        <AuthPanel
          onClose={onCloseAuth}
          onBack={providerSetupChild === "auth" ? onBackFromAuth : undefined}
          initialProvider={authInitialProvider}
          onChanged={onAuthChanged}
        />
      )}
      {showModelsConfig && (
        <ModelsConfigPanel
          onClose={onCloseModelsConfig}
          onBack={
            providerSetupChild === "models" ? onBackFromModelsConfig : undefined
          }
          onChanged={onModelsConfigChanged}
        />
      )}
      {showSystemPrompt && (
        <SystemPromptModal
          text={systemPromptText}
          onClose={onCloseSystemPrompt}
        />
      )}
      {showBranches && agentId && (
        <BranchesPopover
          agentId={agentId}
          onClose={onCloseBranches}
          onNavigated={onBranchesNavigated}
        />
      )}
      <ImageLightbox />
    </>
  );
}
