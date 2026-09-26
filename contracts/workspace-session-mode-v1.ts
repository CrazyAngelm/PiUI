/**
 * Session modes (additive, ADR-034). A live ACP agent may advertise its own
 * session modes (for example approval presets); workspace v15 snapshots carry
 * them as the optional `modes` field and `workspace_session_mode_v1` selects
 * one. Mode names and descriptions are the agent's own text. A live
 * trusted-session action; refused in safe mode. Workspace v15 is unchanged.
 */
export interface SessionModeV1 { id: string; name: string; description?: string }
export interface SessionModesV1 { current: string; available: SessionModeV1[] }
export interface SessionModeRequestV1 { sessionId: string; modeId: string }
export interface SessionModeResultV1 { protocol: 1; sessionId: string; modes?: SessionModesV1 }
