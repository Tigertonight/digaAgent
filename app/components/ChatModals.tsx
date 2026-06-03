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

interface ChatModalsProps {
  // shared
  cwd: string;
  agentId: string | null;
  // CwdPicker
  showCwdPicker: boolean;
  onCloseCwdPicker: () => void;
  onPickCwd: (picked: string) => void;
  // FilePicker
  showFilePicker: boolean;
  onCloseFilePicker: () => void;
  onPickFile: (absPath: string) => void;
  // Skills
  showSkills: boolean;
  onCloseSkills: () => void;
  // Tools
  showTools: boolean;
  onCloseTools: () => void;
  // Provider setup
  showProviderSetup: boolean;
  onCloseProviderSetup: () => void;
  onProviderSetupOpenAuth: (provider?: string) => void;
  onProviderSetupOpenModelsConfig: () => void;
  // Auth
  showAuth: boolean;
  authInitialProvider?: string | null;
  onCloseAuth: () => void;
  onAuthChanged: () => void;
  // ModelsConfig
  showModelsConfig: boolean;
  onCloseModelsConfig: () => void;
  onModelsConfigChanged: () => void;
  // SystemPrompt
  showSystemPrompt: boolean;
  systemPromptText: string | null;
  onCloseSystemPrompt: () => void;
  // Branches
  showBranches: boolean;
  onCloseBranches: () => void;
  onBranchesNavigated: () => void;
}

export function ChatModals({
  cwd,
  agentId,
  showCwdPicker,
  onCloseCwdPicker,
  onPickCwd,
  showFilePicker,
  onCloseFilePicker,
  onPickFile,
  showSkills,
  onCloseSkills,
  showTools,
  onCloseTools,
  showProviderSetup,
  onCloseProviderSetup,
  onProviderSetupOpenAuth,
  onProviderSetupOpenModelsConfig,
  showAuth,
  authInitialProvider,
  onCloseAuth,
  onAuthChanged,
  showModelsConfig,
  onCloseModelsConfig,
  onModelsConfigChanged,
  showSystemPrompt,
  systemPromptText,
  onCloseSystemPrompt,
  showBranches,
  onCloseBranches,
  onBranchesNavigated,
}: ChatModalsProps) {
  return (
    <>
      {showCwdPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.4)" }}
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
              boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
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
          style={{ background: "rgba(0,0,0,0.4)" }}
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
              boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
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
          style={{ background: "rgba(0,0,0,0.4)" }}
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
          initialProvider={authInitialProvider}
          onChanged={onAuthChanged}
        />
      )}
      {showModelsConfig && (
        <ModelsConfigPanel
          onClose={onCloseModelsConfig}
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
