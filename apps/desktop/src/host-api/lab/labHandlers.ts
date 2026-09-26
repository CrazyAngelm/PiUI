/** A lab command handler receives the raw `invoke` arguments, exactly like a Tauri command. */
export type LabArgs = Readonly<Record<string, unknown>>;
export type LabHandler = (args: LabArgs) => unknown;
export type LabHandlers = Readonly<Record<string, LabHandler>>;
