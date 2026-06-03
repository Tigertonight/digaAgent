"use client";

import { useCallback, useReducer, type SetStateAction } from "react";

interface ChatModalsState {
  showAuth: boolean;
  authInitialProvider: string | null;
  showModelsConfig: boolean;
  showProviderSetup: boolean;
  showSystemPrompt: boolean;
  systemPromptText: string | null;
  showCwdPicker: boolean;
  showFilePicker: boolean;
  showBranches: boolean;
}

type BooleanKey =
  | "showAuth"
  | "showModelsConfig"
  | "showProviderSetup"
  | "showSystemPrompt"
  | "showCwdPicker"
  | "showFilePicker"
  | "showBranches";

type Action =
  | { type: "setBoolean"; key: BooleanKey; value: boolean }
  | { type: "openAuth"; provider?: string | null }
  | { type: "closeAuth" }
  | { type: "setSystemPromptText"; text: string | null }
  | { type: "closeSystemPrompt" };

const INITIAL: ChatModalsState = {
  showAuth: false,
  authInitialProvider: null,
  showModelsConfig: false,
  showProviderSetup: false,
  showSystemPrompt: false,
  systemPromptText: null,
  showCwdPicker: false,
  showFilePicker: false,
  showBranches: false,
};

function reducer(
  state: ChatModalsState,
  action: Action
): ChatModalsState {
  switch (action.type) {
    case "setBoolean":
      return { ...state, [action.key]: action.value };
    case "openAuth":
      return {
        ...state,
        showAuth: true,
        authInitialProvider: action.provider?.trim() || null,
      };
    case "closeAuth":
      return { ...state, showAuth: false, authInitialProvider: null };
    case "setSystemPromptText":
      return { ...state, systemPromptText: action.text };
    case "closeSystemPrompt":
      return {
        ...state,
        showSystemPrompt: false,
        systemPromptText: null,
      };
    default:
      return state;
  }
}

function resolveBoolean(prev: boolean, next: SetStateAction<boolean>): boolean {
  return typeof next === "function"
    ? (next as (value: boolean) => boolean)(prev)
    : next;
}

export function useChatModalsState() {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const makeBooleanSetter = useCallback(
    (key: BooleanKey) => (next: SetStateAction<boolean>) => {
      dispatch({
        type: "setBoolean",
        key,
        value: resolveBoolean(state[key], next),
      });
    },
    [state]
  );

  const setShowAuth = useCallback(
    (next: SetStateAction<boolean>) => {
      const value = resolveBoolean(state.showAuth, next);
      if (value) dispatch({ type: "openAuth" });
      else dispatch({ type: "closeAuth" });
    },
    [state.showAuth]
  );

  const openAuth = useCallback((provider?: string | null) => {
    dispatch({ type: "openAuth", provider });
  }, []);

  const closeAuth = useCallback(() => {
    dispatch({ type: "closeAuth" });
  }, []);

  const closeSystemPrompt = useCallback(() => {
    dispatch({ type: "closeSystemPrompt" });
  }, []);

  const setSystemPromptText = useCallback((text: string | null) => {
    dispatch({ type: "setSystemPromptText", text });
  }, []);

  return {
    ...state,
    setShowAuth,
    openAuth,
    closeAuth,
    setShowModelsConfig: makeBooleanSetter("showModelsConfig"),
    setShowProviderSetup: makeBooleanSetter("showProviderSetup"),
    setShowSystemPrompt: makeBooleanSetter("showSystemPrompt"),
    setShowCwdPicker: makeBooleanSetter("showCwdPicker"),
    setShowFilePicker: makeBooleanSetter("showFilePicker"),
    setShowBranches: makeBooleanSetter("showBranches"),
    setSystemPromptText,
    closeSystemPrompt,
  };
}
