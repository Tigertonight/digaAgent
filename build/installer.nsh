!macro customCheckAppRunning
  ; The default electron-builder check matches every process under $INSTDIR,
  ; which can mis-detect installer helpers during upgrades. Diga only needs the
  ; Electron parent closed; its server child exits with that parent.
  nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV | "$FindPath" /I "${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  StrCmp $R0 0 0 diga_check_done

  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK diga_close_app
  Quit

  diga_close_app:
    DetailPrint "$(appClosing)"
    nsExec::Exec `"$CmdPath" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    Pop $R0
    Sleep 1000
    StrCpy $R1 0

  diga_wait_loop:
    IntOp $R1 $R1 + 1
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV | "$FindPath" /I "${APP_EXECUTABLE_FILENAME}"`
    Pop $R0
    StrCmp $R0 0 0 diga_check_done
    DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
    Sleep 1000
    IntCmp $R1 20 diga_retry_prompt diga_wait_loop diga_retry_prompt

  diga_retry_prompt:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY diga_close_app
    Quit

  diga_check_done:
!macroend

!macro digaHandleUninstallResult LABEL_PREFIX
  IfErrors 0 ${LABEL_PREFIX}_uninstall_launched
    DetailPrint `Previous Diga Agent uninstaller could not be launched; continuing with overwrite install.`
    ClearErrors
    Goto ${LABEL_PREFIX}_uninstall_done

  ${LABEL_PREFIX}_uninstall_launched:
    StrCmp $R0 0 ${LABEL_PREFIX}_uninstall_done 0
    IfSilent ${LABEL_PREFIX}_continue_silent 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit

  ${LABEL_PREFIX}_continue_silent:
    DetailPrint `Previous Diga Agent uninstaller returned $R0; continuing silent overwrite install.`
    StrCpy $R0 0

  ${LABEL_PREFIX}_uninstall_done:
!macroend

!macro customUnInstallCheck
  !insertmacro digaHandleUninstallResult diga_shell_context
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro digaHandleUninstallResult diga_current_user
!macroend
