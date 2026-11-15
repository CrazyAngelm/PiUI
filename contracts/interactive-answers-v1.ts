/** Instruction preference only: existing answers remain renderable. Safe mode disables both. */
export interface InteractiveAnswersSettingsV1 {
  readonly protocol: 1;
  readonly enabled: boolean;
  readonly readOnly: boolean;
}

export type InteractiveAnswersSettingsRequest = Readonly<Record<string, never>>;
export interface InteractiveAnswersUpdateRequest { readonly enabled: boolean }
export type InteractiveAnswersErrorCode = 'read-only' | 'io';

export interface InteractiveAnswersHostCommandsV1 {
  interactive_answers_settings_v1(request: InteractiveAnswersSettingsRequest): Promise<InteractiveAnswersSettingsV1>;
  interactive_answers_update_v1(request: InteractiveAnswersUpdateRequest): Promise<InteractiveAnswersSettingsV1>;
}
